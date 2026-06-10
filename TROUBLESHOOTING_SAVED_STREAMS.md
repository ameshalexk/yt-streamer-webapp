# Troubleshooting: Saved Streams Not Showing on Second PC

## Issue
Saved streams appear on Windows PC but not on second PC after implementing server-side storage.

## Likely Cause: Browser Cache

The JavaScript code was changed from using `localStorage` (browser-specific) to using server-side API calls. If your browsers have cached the old JavaScript code, you'll see inconsistent behavior.

## Solution: Clear Browser Cache

### On Windows PC:
1. Open Home Assistant in your browser
2. Press `Ctrl + Shift + Delete` (or `Ctrl + F5` for hard refresh)
3. Select "Cached images and files"
4. Clear cache for "Last hour" or "All time"
5. Or simply press `Ctrl + Shift + R` for a hard refresh

### On Second PC:
1. Open Home Assistant in your browser  
2. Press `Ctrl + Shift + Delete` (or `Ctrl + F5` for hard refresh)
3. Select "Cached images and files"
4. Clear cache for "Last hour" or "All time"
5. Or simply press `Ctrl + Shift + R` for a hard refresh

### Alternative: Browser DevTools
1. Open DevTools (F12)
2. Right-click the refresh button
3. Select "Empty Cache and Hard Reload"

## Verify It's Working

After clearing cache on both PCs:

1. **Both PCs should show the same saved streams** (from `yt_streamer_library/saved_streams.json`)
2. **Adding a stream on one PC should appear on the other PC** (after refresh)
3. **Deleting a stream on one PC should remove it from the other PC** (after refresh)

## Current Saved Streams

Your saved streams are stored in:
- File: `/config/yt_streamer_library/saved_streams.json`
- Currently contains: 3 streams (main, 123, aaj tak)

These are server-side and shared across all devices.

## If Still Not Working

1. **Check browser console** (F12 → Console) for errors
2. **Verify Home Assistant is restarted** after code changes
3. **Check network tab** to see if API calls are being made:
   - Should see: `GET /api/yt_streamer/api/m3u8_saved_streams`
4. **Verify API endpoint works**: Try accessing directly (requires authentication)

## Testing

To test if it's working:
1. On Windows PC: Add a test stream
2. Wait a few seconds
3. On second PC: Hard refresh (Ctrl+Shift+R)
4. The test stream should appear on second PC

If this works, the implementation is correct and it was just a cache issue!
