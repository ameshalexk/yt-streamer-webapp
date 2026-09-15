#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardware.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <fcntl.h>
#import <signal.h>
#import <stdatomic.h>
#import <unistd.h>

static volatile sig_atomic_t gStop = 0;
static int gAudioFD = STDOUT_FILENO;
static FILE *gStatusFile = NULL;

static void handleSignal(int signalValue) {
    (void)signalValue;
    gStop = 1;
}

static NSString *statusString(OSStatus status) {
    UInt32 be = CFSwapInt32HostToBig((UInt32)status);
    char chars[5] = {0};
    memcpy(chars, &be, 4);
    BOOL printable = YES;
    for (int i = 0; i < 4; i++) {
        if (chars[i] < 32 || chars[i] > 126) printable = NO;
    }
    if (printable) return [NSString stringWithFormat:@"%d ('%s')", (int)status, chars];
    return [NSString stringWithFormat:@"%d", (int)status];
}

static void emitControl(NSDictionary *object) {
    NSMutableDictionary *payload = [object mutableCopy];
    payload[@"helperPid"] = @(getpid());
    payload[@"timestampMs"] = @((long long)(NSDate.date.timeIntervalSince1970 * 1000.0));
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (!data) return;

    fputs("YTAP ", stderr);
    fwrite(data.bytes, 1, data.length, stderr);
    fputc('\n', stderr);
    fflush(stderr);

    if (gStatusFile) {
        fputs("YTAP ", gStatusFile);
        fwrite(data.bytes, 1, data.length, gStatusFile);
        fputc('\n', gStatusFile);
        fflush(gStatusFile);
    }
}

static AudioObjectID processObjectForPID(pid_t pid) {
    AudioObjectPropertyAddress address = {
        kAudioHardwarePropertyTranslatePIDToProcessObject,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    AudioObjectID objectID = kAudioObjectUnknown;
    UInt32 size = sizeof(objectID);
    OSStatus status = AudioObjectGetPropertyData(
        kAudioObjectSystemObject,
        &address,
        sizeof(pid),
        &pid,
        &size,
        &objectID
    );
    return status == noErr ? objectID : kAudioObjectUnknown;
}

static BOOL tapFormat(AudioObjectID tapID, AudioStreamBasicDescription *outFormat) {
    AudioObjectPropertyAddress address = {
        kAudioTapPropertyFormat,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    UInt32 size = sizeof(*outFormat);
    return AudioObjectGetPropertyData(tapID, &address, 0, NULL, &size, outFormat) == noErr;
}

static BOOL supportedFloatFormat(AudioStreamBasicDescription format) {
    return format.mFormatID == kAudioFormatLinearPCM
        && (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        && (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
        && format.mBitsPerChannel == 32
        && format.mChannelsPerFrame == 2;
}

static BOOL waitForDeviceAlive(AudioObjectID deviceID, NSTimeInterval timeoutSeconds) {
    AudioObjectPropertyAddress address = {
        kAudioDevicePropertyDeviceIsAlive,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain
    };
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeoutSeconds];
    do {
        UInt32 alive = 0;
        UInt32 size = sizeof(alive);
        OSStatus status = AudioObjectGetPropertyData(deviceID, &address, 0, NULL, &size, &alive);
        if (status == noErr && alive != 0) return YES;
        [NSThread sleepForTimeInterval:0.02];
    } while (!gStop && deadline.timeIntervalSinceNow > 0);
    return NO;
}

static void writeAll(int fd, const void *bytes, size_t length) {
    if (fd < 0) return;
    const uint8_t *cursor = bytes;
    size_t remaining = length;
    while (remaining > 0 && !gStop) {
        ssize_t written = write(fd, cursor, remaining);
        if (written > 0) {
            cursor += written;
            remaining -= (size_t)written;
            continue;
        }
        if (written < 0 && errno == EINTR) continue;
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
        gStop = 1;
        return;
    }
}

static OSStatus audioIOProc(
    AudioObjectID inDevice,
    const AudioTimeStamp *inNow,
    const AudioBufferList *inInputData,
    const AudioTimeStamp *inInputTime,
    AudioBufferList *outOutputData,
    const AudioTimeStamp *inOutputTime,
    void *inClientData
) {
    (void)inDevice;
    (void)inNow;
    (void)inInputTime;
    (void)outOutputData;
    (void)inOutputTime;
    (void)inClientData;
    if (!inInputData || inInputData->mNumberBuffers == 0) return noErr;
    const AudioBuffer buffer = inInputData->mBuffers[0];
    if (!buffer.mData || buffer.mDataByteSize == 0) return noErr;
    writeAll(gAudioFD, buffer.mData, buffer.mDataByteSize);
    return noErr;
}

static OSStatus createIOProcWhilePumpingRunLoop(
    AudioObjectID deviceID,
    AudioDeviceIOProcID *outIOProcID,
    NSTimeInterval timeoutSeconds
) {
    __block OSStatus result = kAudioHardwareUnspecifiedError;
    __block AudioDeviceIOProcID created = NULL;
    __block atomic_bool finished = false;

    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        result = AudioDeviceCreateIOProcID(deviceID, audioIOProc, NULL, &created);
        atomic_store(&finished, true);
    });

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeoutSeconds];
    while (!atomic_load(&finished) && !gStop && deadline.timeIntervalSinceNow > 0) {
        @autoreleasepool {
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }
    }

    if (!atomic_load(&finished)) return kAudioHardwareNotRunningError;
    *outIOProcID = created;
    return result;
}

static void cleanupFiles(void) {
    if (gAudioFD >= 0 && gAudioFD != STDOUT_FILENO) {
        close(gAudioFD);
        gAudioFD = -1;
    }
    if (gStatusFile) {
        fclose(gStatusFile);
        gStatusFile = NULL;
    }
}

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        NSMutableArray<NSNumber *> *pids = [NSMutableArray array];
        BOOL mute = YES;
        NSString *name = @"YT Streamer Chrome Process Tap";
        NSString *pcmFifo = nil;
        NSString *statusFile = nil;

        for (int i = 1; i < argc; i++) {
            NSString *arg = [NSString stringWithUTF8String:argv[i]];
            if ([arg isEqualToString:@"--pid"] && i + 1 < argc) {
                pid_t pid = (pid_t)atoi(argv[++i]);
                if (pid > 1) [pids addObject:@(pid)];
            } else if ([arg isEqualToString:@"--mute"] && i + 1 < argc) {
                mute = atoi(argv[++i]) != 0;
            } else if ([arg isEqualToString:@"--name"] && i + 1 < argc) {
                name = [NSString stringWithUTF8String:argv[++i]];
            } else if ([arg isEqualToString:@"--pcm-fifo"] && i + 1 < argc) {
                pcmFifo = [NSString stringWithUTF8String:argv[++i]];
            } else if ([arg isEqualToString:@"--status-file"] && i + 1 < argc) {
                statusFile = [NSString stringWithUTF8String:argv[++i]];
            }
        }

        if (statusFile.length) {
            gStatusFile = fopen(statusFile.fileSystemRepresentation, "a");
        }

        signal(SIGINT, handleSignal);
        signal(SIGTERM, handleSignal);
        signal(SIGHUP, handleSignal);
        signal(SIGPIPE, SIG_IGN);

        if (pids.count == 0) {
            emitControl(@{@"ready": @NO, @"error": @"At least one --pid is required."});
            cleanupFiles();
            return 64;
        }

        if (pcmFifo.length) {
            gAudioFD = open(pcmFifo.fileSystemRepresentation, O_WRONLY | O_NONBLOCK);
            if (gAudioFD < 0 && errno == ENXIO) {
                // Keep first launch nonblocking even if the reader has not attached yet.
                gAudioFD = open(pcmFifo.fileSystemRepresentation, O_RDWR | O_NONBLOCK);
            }
            if (gAudioFD < 0) {
                emitControl(@{
                    @"ready": @NO,
                    @"error": [NSString stringWithFormat:@"Could not open PCM pipe: %s", strerror(errno)]
                });
                cleanupFiles();
                return 65;
            }
        }

        emitControl(@{@"stage": @"resolve-processes"});
        NSMutableArray<NSNumber *> *processObjects = [NSMutableArray array];
        NSMutableArray<NSNumber *> *resolvedPids = [NSMutableArray array];
        NSDate *processDeadline = [NSDate dateWithTimeIntervalSinceNow:6.0];

        do {
            [processObjects removeAllObjects];
            [resolvedPids removeAllObjects];
            NSMutableSet<NSNumber *> *seen = [NSMutableSet set];
            for (NSNumber *pidNumber in pids) {
                pid_t pid = (pid_t)pidNumber.intValue;
                AudioObjectID objectID = processObjectForPID(pid);
                if (objectID == kAudioObjectUnknown) continue;
                NSNumber *boxedObject = @(objectID);
                if ([seen containsObject:boxedObject]) continue;
                [seen addObject:boxedObject];
                [processObjects addObject:boxedObject];
                [resolvedPids addObject:@(pid)];
            }
            if (processObjects.count > 0) break;
            [NSThread sleepForTimeInterval:0.1];
        } while (!gStop && processDeadline.timeIntervalSinceNow > 0);

        if (processObjects.count == 0) {
            emitControl(@{
                @"ready": @NO,
                @"error": @"Chrome has not opened a Core Audio output stream yet. Start media playback and retry.",
                @"pids": pids
            });
            cleanupFiles();
            return 69;
        }

        emitControl(@{@"stage": @"create-tap", @"resolvedPids": resolvedPids});
        CATapDescription *description = [[CATapDescription alloc] initStereoMixdownOfProcesses:processObjects];
        description.name = name;
        description.privateTap = YES;
        description.muteBehavior = mute ? CATapMuted : CATapUnmuted;
        if (@available(macOS 26.0, *)) description.processRestoreEnabled = YES;

        AudioObjectID tapID = kAudioObjectUnknown;
        OSStatus status = AudioHardwareCreateProcessTap(description, &tapID);
        emitControl(@{@"stage": @"tap-created", @"status": @(status)});
        if (status != noErr || tapID == kAudioObjectUnknown) {
            emitControl(@{
                @"ready": @NO,
                @"error": [NSString stringWithFormat:@"AudioHardwareCreateProcessTap failed: %@", statusString(status)]
            });
            cleanupFiles();
            return 70;
        }

        AudioStreamBasicDescription format = {0};
        if (!tapFormat(tapID, &format)) {
            AudioHardwareDestroyProcessTap(tapID);
            emitControl(@{@"ready": @NO, @"error": @"Could not read Core Audio tap format."});
            cleanupFiles();
            return 71;
        }

        if (!supportedFloatFormat(format)) {
            AudioHardwareDestroyProcessTap(tapID);
            emitControl(@{
                @"ready": @NO,
                @"error": @"Core Audio returned an unsupported tap format.",
                @"sampleRate": @(format.mSampleRate),
                @"channels": @(format.mChannelsPerFrame),
                @"bits": @(format.mBitsPerChannel),
                @"formatFlags": @(format.mFormatFlags)
            });
            cleanupFiles();
            return 72;
        }

        NSString *aggregateUID = [NSString stringWithFormat:
            @"com.ameshalex.ytstreamer.process-tap.%@", description.UUID.UUIDString];
        NSDictionary *aggregateDescription = @{
            @"name": name,
            @"uid": aggregateUID,
            @"private": @YES
        };

        emitControl(@{@"stage": @"create-aggregate"});
        AudioObjectID aggregateID = kAudioObjectUnknown;
        status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregateDescription, &aggregateID);
        emitControl(@{
            @"stage": @"aggregate-created",
            @"status": @(status),
            @"aggregateID": @(aggregateID)
        });

        if (status != noErr || aggregateID == kAudioObjectUnknown) {
            AudioHardwareDestroyProcessTap(tapID);
            emitControl(@{
                @"ready": @NO,
                @"error": [NSString stringWithFormat:@"AudioHardwareCreateAggregateDevice failed: %@", statusString(status)]
            });
            cleanupFiles();
            return 73;
        }

        emitControl(@{@"stage": @"wait-aggregate-alive"});
        if (!waitForDeviceAlive(aggregateID, 3.0)) {
            AudioHardwareDestroyAggregateDevice(aggregateID);
            AudioHardwareDestroyProcessTap(tapID);
            emitControl(@{@"ready": @NO, @"error": @"Core Audio aggregate did not become ready."});
            cleanupFiles();
            return 75;
        }

        emitControl(@{@"stage": @"attach-tap"});
        AudioObjectPropertyAddress tapListAddress = {
            kAudioAggregateDevicePropertyTapList,
            kAudioObjectPropertyScopeGlobal,
            kAudioObjectPropertyElementMain
        };
        CFArrayRef tapList = (__bridge CFArrayRef)@[description.UUID.UUIDString];
        UInt32 tapListSize = sizeof(tapList);
        status = AudioObjectSetPropertyData(
            aggregateID,
            &tapListAddress,
            0,
            NULL,
            tapListSize,
            &tapList
        );
        emitControl(@{@"stage": @"tap-attached", @"status": @(status)});

        if (status != noErr) {
            AudioHardwareDestroyAggregateDevice(aggregateID);
            AudioHardwareDestroyProcessTap(tapID);
            emitControl(@{
                @"ready": @NO,
                @"error": [NSString stringWithFormat:@"Could not attach tap to aggregate: %@", statusString(status)]
            });
            cleanupFiles();
            return 77;
        }

        [NSThread sleepForTimeInterval:0.15];

        emitControl(@{@"stage": @"create-ioproc"});
        AudioDeviceIOProcID ioProcID = NULL;
        status = createIOProcWhilePumpingRunLoop(aggregateID, &ioProcID, 45.0);
        emitControl(@{@"stage": @"ioproc-created", @"status": @(status)});

        if (status != noErr || ioProcID == NULL) {
            AudioHardwareDestroyAggregateDevice(aggregateID);
            AudioHardwareDestroyProcessTap(tapID);
            NSString *message = status == kAudioHardwareNotRunningError
                ? @"System Audio Recording permission is required. Enable YT Streamer Audio Tap in Privacy & Security, then retry."
                : [NSString stringWithFormat:@"AudioDeviceCreateIOProcID failed: %@", statusString(status)];
            emitControl(@{@"ready": @NO, @"error": message, @"permissionRequired": @(status == kAudioHardwareNotRunningError)});
            cleanupFiles();
            return 74;
        }

        emitControl(@{
            @"ready": @YES,
            @"sampleRate": @(format.mSampleRate),
            @"channels": @(format.mChannelsPerFrame),
            @"sampleFormat": @"f32le",
            @"tapUUID": description.UUID.UUIDString,
            @"tapID": @(tapID),
            @"aggregateID": @(aggregateID),
            @"mute": @(mute),
            @"pids": resolvedPids
        });

        emitControl(@{@"stage": @"start-device"});
        status = AudioDeviceStart(aggregateID, ioProcID);
        emitControl(@{@"stage": @"device-started", @"status": @(status)});

        if (status != noErr) {
            emitControl(@{
                @"runtimeError": [NSString stringWithFormat:@"AudioDeviceStart failed: %@", statusString(status)]
            });
            gStop = 1;
        }

        while (!gStop) {
            @autoreleasepool {
                [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
            }
        }

        AudioDeviceStop(aggregateID, ioProcID);
        AudioDeviceDestroyIOProcID(aggregateID, ioProcID);
        AudioHardwareDestroyAggregateDevice(aggregateID);
        AudioHardwareDestroyProcessTap(tapID);
        emitControl(@{@"stopped": @YES});
        cleanupFiles();
    }
    return 0;
}
