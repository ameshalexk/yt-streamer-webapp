# APNE show catalog additions (2026-10-16)

The running Mac streamer registered these shows through the existing show-management API. Active show subscriptions are stored in a runtime JSON file, deliberately ignored by Git.

| Show | APNE source |
| --- | --- |
| Shayad Yahi Hai Pyaar | https://apnetv.xyz/Hindi-Serial/Shayad-Yahi-Hai-Pyaar |
| Yeh Fitoor Tera | https://apnetv.xyz/Hindi-Serial/Yeh-Fitoor-Tera |
| 108 Base Hospital Uri | https://apnetv.xyz/Hindi-Serial/108-Base-Hospital-Uri |

Some APNE shows list multiple numbered episodes on one air date. The fix gives each a unique ID, for example 2026-10-12-e15 instead of collapsing them all into 2026-10-12. Normal date-only IDs remain unchanged.

Production is newer than this GitHub main branch and has additional streaming, source-verification and watch-progress modules absent from main. This commit ports the compatible parser behavior and documents the show subscriptions; it must not be deployed as a full replacement for the production runtime until the existing version drift is reconciled.
