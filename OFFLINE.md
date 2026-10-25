# Offline use

Apogee can start and run with no network once it has been opened online one time. A small program in the browser, the **service worker** (`sw.js`), keeps a copy of the app's own files and serves them. Your workouts are not part of that copy: they live in the browser's database (IndexedDB), exactly as before, and the worker never reads or writes them.

The worker only talks to the same website the app came from, to save the app's files and to check whether a new version exists. It never contacts any other host.

## Which version do I have?

Settings tab, Backup section, **Offline** card: it says whether the app is ready to start without a network, and shows the first 8 characters of the offline copy's version (for example `5978098f`). Every change to the app gives a new version.

## How an update reaches you

1. A new version is published. Your browser notices when you open the app, and when you come back to it (at most once an hour).
2. It downloads the new files in the background. All of them, or nothing: if even one file cannot be saved, the new version is not installed, and the version you have keeps working exactly as before. The browser tries again at the next check.
3. When the new version is ready, **it waits**. A banner at the top says **Update available** with a **Reload** button. The app keeps running the version you started with; nothing changes under you.
4. When you click **Reload**, the new version takes over and the page reloads. Your workouts are not changed.

If you have the app open in two tabs and update in one, the other tab shows "The app was updated in another tab. Reload this tab to use the new version." It does not reload by itself.

Why it is done this way: a worker that swapped itself in while the app is open could serve old code against data that a newer version has already changed. So an update never takes over an open app unless you click.

One thing you cannot prevent, and need not fear: a waiting version also becomes the active one by the browser's own rules when no window of the app is open any more (every tab and installed window closed). The next time you open the app it is the new version from the first file on, so no old code ever runs next to it.

## Working on the app

- On `127.0.0.1`, `localhost` and `[::1]` the worker does **not** register by itself, because an installed copy would keep showing old files after every edit. Add `?sw=1` to the address (`http://127.0.0.1:8080/?sw=1`) to use it. Everywhere else (the live site) it registers automatically.
- After changing **any** file the app loads (anything under `src/`, `index.html`, `manifest.webmanifest`, the icons) or `sw.js`, run `node tools/build-sw-manifest.js`. It rewrites `sw-manifest.js`: the list of files to save and the version, both found from what the app really loads. `node --test` fails while that file is out of date, so a forgotten rebuild cannot be committed unnoticed.
- The browser test page (`tests/browser/index.html`) is never served from the offline copy, so it always tests the current files. It also never touches the app's own offline copy.
- If the page you see is not the code you just edited: you are looking at the installed copy. Rebuild, then use the **Reload** on the banner, or Settings, Backup, Offline, **Reset offline copy**.

## iPhone

- On an iPhone, an app added to the Home Screen has been reported to keep its **own** storage, separate from Safari's tabs. If so, workouts logged in Safari do not appear in the installed app until you **Export** in one and **Import** in the other. This has not been checked on a device yet; check before relying on it.
- Safari is documented to delete a website's stored data after about 7 days without a visit, except for apps added to the Home Screen. Treat that as unverified too. A recent export is the only safety net you control.

## If something goes wrong

> **Warning: "clear site data" also deletes your workouts.**
> Clearing a website's data (Clear site data in developer tools, "Cookies and site data" in Clear browsing data, Settings, Safari, Advanced, Website Data on an iPhone) removes the offline copy **and the database with all your workouts**. There is no way back from that unless you exported first.
> **Export first:** Settings tab, Backup section, **Download export file**, or **Show export as text** and copy it somewhere safe.

What each action removes:

| Action | Offline copy | Your workouts |
|---|---|---|
| Settings, Backup, Offline, **Reset offline copy** | removed (this app's worker and caches only) | **kept** |
| Developer tools: Unregister the worker, delete the `apogee-precache-…` caches | removed | **kept** |
| Clear site data / Website Data | removed | **DELETED** |

Try these in order, and stop when it works:

1. **Settings tab, Backup section, Offline, Reset offline copy** (it asks first). It removes this app's worker and caches only. Then reload the page while online; the app downloads itself again. Your workouts are untouched.
2. **If the page itself is broken and the Settings tab or its Backup section will not open:** a fixed version, once published, installs and waits. Close **every** tab and installed window of the app (on an iPhone, swipe the app away in the app switcher), then open it again. The fixed version is in charge from the first file on. No data is deleted by this.
3. **On a computer, if that does not help:** open the browser's developer tools on the app's page.
   - Chrome or Edge: Application, **Service Workers**, Unregister the worker of this site; then Application, **Cache Storage**, delete the caches whose names start with `apogee-precache-` (leave any other caches alone).
   - Firefox: `about:serviceworkers`, Unregister the entry for this site; then developer tools, Storage, **Cache Storage**, delete the `apogee-precache-…` caches.
   - Do **not** press "Clear site data" in the same panel. Reload afterwards.
4. **On an iPhone there are no developer tools.** To check whether the site itself works, open it in a **Private** tab: that has separate, empty storage, and your normal data stays where it is.
5. **Last resort, and only after an export:** clear the site's data, open the app, and **Import** the export file (Settings tab, Backup section). If you cannot reach the Backup section to make an export, do not clear anything: try steps 2 and 3 first.

Keep a recent export. Browsers can remove a site's data on their own, and an export is the only copy you control.

## An older version meets newer data

The storage format only moves forward. Schema version 3 (exercise grouping fields) upgrades the database the first time the new version opens it, and an older version cannot open it again. Schema version 4 (templates) works the same way: a version 3 build that meets schema 4 data shows the message below with "(schema 3)" in place of "(schema 2)". If an older version of the app is ever running against the upgraded database (for example a copy that has not updated yet, or the site rolled back), the page shows only this:

> Apogee could not open its database: Database "apogee" was saved by a newer version of Apogee than this code (schema 2). The data was not changed. Update the app.

Nothing is lost: the data is left exactly as it was. There is no Update available banner on that screen, because the app did not start. To get the newer version: close every tab and installed window of the app (on an iPhone, swipe it away in the app switcher) and open it again while online, as in step 2 above. If the site itself was rolled back, it has to be published again at the newer version; an older version can never open data of a newer schema.

An export made by the newer version cannot be imported by an older one either (it says the file was exported by a newer version). An export from the older version can always be imported by the newer one.

## What to look at when it misbehaves

- Settings tab, Backup section, Offline: is it Ready? Which version?
- Developer tools, Application (Chrome) or Storage (Firefox): the Service Workers list shows the worker's state (activated, waiting) and Cache Storage shows which versions are saved.
- The first 8 characters of the version are in the Offline card (Settings, Backup section) and are the first 8 characters of the cache's name (`apogee-precache-<version>`).
