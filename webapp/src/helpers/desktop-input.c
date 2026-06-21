#include <ApplicationServices/ApplicationServices.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static CGMouseButton button_for(int button) {
  return button == 2 ? kCGMouseButtonRight : kCGMouseButtonLeft;
}

static CGEventType event_for(const char *action, int button) {
  if (button == 2) {
    if (strcmp(action, "down") == 0) return kCGEventRightMouseDown;
    if (strcmp(action, "up") == 0) return kCGEventRightMouseUp;
    if (strcmp(action, "drag") == 0) return kCGEventRightMouseDragged;
  }
  if (strcmp(action, "down") == 0) return kCGEventLeftMouseDown;
  if (strcmp(action, "up") == 0) return kCGEventLeftMouseUp;
  if (strcmp(action, "drag") == 0) return kCGEventLeftMouseDragged;
  return kCGEventMouseMoved;
}

static int trusted_with_prompt(int prompt) {
  if (!prompt) return AXIsProcessTrusted() ? 1 : 0;
  const void *keys[] = { kAXTrustedCheckOptionPrompt };
  const void *values[] = { kCFBooleanTrue };
  CFDictionaryRef opts = CFDictionaryCreate(
    kCFAllocatorDefault,
    keys,
    values,
    1,
    &kCFCopyStringDictionaryKeyCallBacks,
    &kCFTypeDictionaryValueCallBacks
  );
  int trusted = AXIsProcessTrustedWithOptions(opts) ? 1 : 0;
  if (opts) CFRelease(opts);
  return trusted;
}

static void post_mouse(const char *action, double x, double y, int button) {
  CGPoint point = CGPointMake(x, y);
  CGEventRef event = CGEventCreateMouseEvent(NULL, event_for(action, button), point, button_for(button));
  if (!event) return;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

static void post_scroll(double dx, double dy) {
  int sx = (int)dx;
  int sy = (int)dy;
  CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, sy, sx);
  if (!event) return;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

static void status(unsigned long id, int prompt) {
  CGRect bounds = CGDisplayBounds(CGMainDisplayID());
  printf(
    "%lu ok status trusted=%d x=%.0f y=%.0f width=%.0f height=%.0f\n",
    id,
    trusted_with_prompt(prompt),
    bounds.origin.x,
    bounds.origin.y,
    bounds.size.width,
    bounds.size.height
  );
}

static int parse_button(const char *value) {
  int button = atoi(value);
  return button == 2 ? 2 : 1;
}

int main(void) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  char line[256];

  while (fgets(line, sizeof(line), stdin)) {
    unsigned long id = 0;
    char action[16] = {0};
    char a[64] = {0};
    char b[64] = {0};
    char c[64] = {0};
    char d[64] = {0};
    char e[64] = {0};
    int count = sscanf(line, "%lu %15s %63s %63s %63s %63s %63s", &id, action, a, b, c, d, e);

    if (count < 2) {
      printf("%lu err invalid-command\n", id);
      continue;
    }

    if (strcmp(action, "status") == 0) {
      status(id, count >= 3 && atoi(a) == 1);
      continue;
    }

    if (strcmp(action, "move") == 0 || strcmp(action, "down") == 0 || strcmp(action, "drag") == 0 || strcmp(action, "up") == 0) {
      if (count < 4) {
        printf("%lu err missing-coordinates\n", id);
        continue;
      }
      int button = count >= 5 ? parse_button(c) : 1;
      post_mouse(action, atof(a), atof(b), button);
      printf("%lu ok %s\n", id, action);
      continue;
    }

    if (strcmp(action, "click") == 0) {
      if (count < 4) {
        printf("%lu err missing-coordinates\n", id);
        continue;
      }
      int button = count >= 5 ? parse_button(c) : 1;
      post_mouse("move", atof(a), atof(b), button);
      post_mouse("down", atof(a), atof(b), button);
      usleep(45000);
      post_mouse("up", atof(a), atof(b), button);
      printf("%lu ok click\n", id);
      continue;
    }

    if (strcmp(action, "scroll") == 0) {
      if (count < 6) {
        printf("%lu err missing-scroll-values\n", id);
        continue;
      }
      post_mouse("move", atof(a), atof(b), 1);
      post_scroll(atof(c), atof(d));
      printf("%lu ok scroll\n", id);
      continue;
    }

    printf("%lu err unknown-action\n", id);
  }

  return 0;
}
