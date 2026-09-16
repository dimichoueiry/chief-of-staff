# Handing the app to someone

How to give Chief of Staff to a friend, and what it takes to give it to a customer.
Status as of 2026-09-15: the self-contained build works; there is no Apple Developer ID yet.

## What a developer build is, and why it can't be handed over

`cos menubar install` builds `~/Applications/Chief of Staff.app`, but that app is a thin
shell. It reads `~/.cos/menubar.json` and starts `/usr/local/bin/node ~/.cos/app/dist/cli/cos.js`.
It needs, on that Mac:

| Needs | Why |
|---|---|
| Node 20+ at the path in `menubar.json` | the server is Node |
| `~/.cos/app` | the runtime `cos menubar build` copied there |
| Xcode command line tools (`swiftc`) | the calendar, screen and player helpers are compiled on first use |
| the repo, `npm install`, `npm run build` | to make all of the above |

Nobody you hand it to has those.

## The self-contained build

```bash
npm run package            # = npm run build && cos menubar package
```

writes `.build/package/Chief of Staff.app` and `.build/package/Chief-of-Staff-<version>-<arch>.dmg`.
The app carries everything:

```
Chief of Staff.app/Contents/
  MacOS/ChiefOfStaff        the Swift shell
  Helpers/node              Node, this Mac's architecture only (lipo-thinned)
  Helpers/cos-calendar      the EventKit helper, prebuilt
  Helpers/cos-screen        the screen helper, prebuilt
  Helpers/cos-play-<hash>   the audio player, prebuilt
  Resources/runtime/        dist + package.json + production node_modules
```

On launch the shell finds `Helpers/node` and `Resources/runtime`, uses them instead of
`menubar.json`, and copies the helpers to `~/.cos/bin`, where the server looks for them
(`ShellConfig.bundled` in `apps/menubar/Sources/ChiefOfStaff/ShellConfig.swift`). Nothing
on the other Mac is compiled or installed.

Size: about 200 MB on disk, 117 MB as a .dmg. Node is 113 MB of that.

Options:

```bash
cos menubar package --no-dmg               # just the .app
cos menubar package --out ~/Desktop/build  # somewhere else
cos menubar package --identity "Developer ID Application: Your Name (TEAMID)"   # see Business below
```

## Check a build

```bash
APP=".build/package/Chief of Staff.app"

# Signature and seal: every nested binary signed, the bundle intact.
codesign --verify --deep --strict --verbose=2 "$APP"

# Gatekeeper's verdict. "rejected" without a Developer ID is expected; "accepted" with a notarized one.
spctl --assess --type execute "$APP"

# The runtime starts with no system Node, no repo, and an empty home.
FRESH=$(mktemp -d)
env -i HOME="$FRESH" COS_HOME="$FRESH/.cos" PATH=/usr/bin:/bin \
  "$APP/Contents/Helpers/node" "$APP/Contents/Resources/runtime/dist/cli/cos.js" ui --port 4799 --no-open &
sleep 2; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4799/api/projects   # 200
kill %1

# What the shell did on launch (helpers seeded, server pid).
tail ~/.cos/logs/menubar.log
```

All four were run on 2026-09-15 against the arm64 build: signature valid, spctl rejected
(local certificate), runtime answered 200 from an empty home, and the packaged app,
launched next to the developer build on another port, seeded its three helpers and
started its own server.

## Personal: friends and testers

Send the .dmg. It is signed with the local certificate, which macOS doesn't know, so
Gatekeeper stops it the first time.

What they do:

1. Open the .dmg, drag Chief of Staff to Applications.
2. Open it. macOS says it can't verify the developer. Close that.
3. System Settings › Privacy & Security, scroll down, **Open Anyway**. (Or right-click the app › Open on older macOS, or `xattr -dr com.apple.quarantine "/Applications/Chief of Staff.app"` in Terminal.)
4. Grant the permissions it asks for: Accessibility, Microphone, Speech Recognition. Screen Recording and Full Disk Access only if they want "look at this" and browser favorites.
5. Paste an API key. The app asks on first launch, and it is always under ✦ › API keys: one field per provider, a "Get a key" link to each, and a live check as it saves. No Terminal, no hidden file.

Good enough for a handful of people who trust you. Not for anyone who doesn't, and not
something you can put on a web page: every download is "damaged or unverified" to the OS.

Limits of the current build:

- **arm64 only.** Built on this Mac, it runs on Apple silicon. An Intel friend needs a build
  from an Intel Mac, or a universal one (see below).
- **Memory history needs git.** The memory itself is written either way; the commit history is
  what waits for Apple's developer tools. ✦ › Memory says so and offers to install them.
- **Its own browser needs Chrome or Edge** installed; the browser feature is off without one.
- **No updates.** A new version is a new .dmg.

## Business: customers

Anyone who paid must be able to double-click the .dmg and see the app open, no warnings.
That is exactly what Apple's Developer ID plus notarization buys, and nothing else does.
Steps, in order; none is done yet.

### 1. Apple Developer Program

Enrol at developer.apple.com (99 USD/year; an organisation needs a D-U-N-S number, an
individual doesn't). In Xcode › Settings › Accounts, add the account and create a
**Developer ID Application** certificate. Check it is in the login keychain:

```bash
security find-identity -v -p codesigning     # lists "Developer ID Application: Name (TEAMID)"
```

Today this prints `0 valid identities found`.

### 2. Sign with it

```bash
cos menubar package --identity "Developer ID Application: Name (TEAMID)"
```

With `--identity` the packager signs every nested binary and the bundle with the hardened
runtime, a secure timestamp and `apps/menubar/Entitlements.plist`. That file already holds
what notarization will demand for this app:

| Entitlement | For |
|---|---|
| `cs.allow-jit`, `cs.allow-unsigned-executable-memory` | Node's JIT under the hardened runtime |
| `cs.disable-library-validation` | Node loading its own dylibs |
| `device.audio-input` | the microphone |
| `personal-information.calendars` | EventKit |
| `automation.apple-events` | "open …" via AppleScript |

Expect to iterate here once: run the app after signing and read `~/.cos/logs/menubar-server.log`.
If Node dies at start under the hardened runtime, the entitlement list is what to adjust.

### 3. Notarize and staple

```bash
# once: an app-specific password from appleid.apple.com, stored in the keychain
xcrun notarytool store-credentials cos-notary --apple-id you@example.com --team-id TEAMID

DMG=.build/package/Chief-of-Staff-0.1.0-arm64.dmg
xcrun notarytool submit "$DMG" --keychain-profile cos-notary --wait
xcrun stapler staple "$DMG"
xcrun stapler staple ".build/package/Chief of Staff.app"
spctl --assess --type execute --verbose ".build/package/Chief of Staff.app"    # accepted, source=Notarized Developer ID
```

If `submit` reports Invalid, `xcrun notarytool log <id> --keychain-profile cos-notary`
names the binary and the reason. The usual ones for a Node app are an unsigned file in
`node_modules` (there are none today: no native addons) or a missing entitlement.

Once this works, `cos menubar package` should grow a `--notarize` flag that runs these three
commands, so a release is one command.

### 4. Universal build

Customers have Intel Macs too. Node publishes both slices; `lipo -create` the arm64 and
x86_64 `node` binaries into one, and build the Swift shell and helpers with
`--arch arm64 --arch x86_64`. The .dmg then serves everyone. Until then, name the
architecture in the download (the packager already does).

### 5. Updates

A .dmg per release is fine to start. The next step is Sparkle (an appcast URL plus an EdDSA
key; it also expects a notarized app), so customers get "a new version is available" in
the menu rather than a new download link.

### 6. Onboarding

- **The key: done.** ✦ › API keys (`KeysWindow.swift` and `GET/POST /api/keys`) writes
  `~/.cos/.env` owner-only and checks the key with one live request. The app offers it once on
  first launch when nothing is set, so a recipient is never left guessing.
- **The memory repo: done.** The server sets the stores up the first time it runs, so nobody
  has to run `cos init`, and git is optional rather than assumed (below).

Both were the difference between "installs" and "works".

### The memory folder, and git

`/usr/bin/git` is on every Mac but only *works* where Apple's command line developer tools are
installed. On a Mac without them it is a stub that opens an "install the developer tools?" dialog
and fails — and because every memory write went through `git init`, **the write itself used to
fail and the note was lost**. That is fixed:

| Behaviour | Why |
|---|---|
| The git that runs is resolved once, Homebrew's before Apple's | one probe per run, not one per write |
| Apple's stub is never executed unless `xcode-select -p` says the tools are there | executing it is what opens that dialog |
| Without git, a write still writes, uncommitted | the history is allowed to be missing; the memory is not |
| The stores are created on first run | a recipient never runs `cos init` |
| An existing store file is never touched | a file someone edited or deleted stays that way |
| When git appears, everything written without it is committed once | "every write is a commit" catches up |

✦ › Memory shows the folder, whether history is on, and the way to fix it: "Turn history on
(install developer tools)…" runs `xcode-select --install`, "Look for git again" re-checks without
a restart. The menu title carries a ⚠︎ while anything is off.

`COS_GIT` points at a specific git if you keep one somewhere unusual.

Verify it the way it was verified here, by faking a Mac with no tools:

```bash
T=$(mktemp -d); mkdir -p "$T/stub"
printf '#!/bin/sh\nexit 1\n' > "$T/stub/git"
printf '#!/bin/sh\n[ "$1" = "-p" ] && exit 2\nexit 0\n' > "$T/stub/xcode-select"
chmod +x "$T/stub"/*
(cd /tmp && env -i HOME="$T" COS_HOME="$T/.cos" COS_SELFHUB="$T/selfhub" PATH="$T/stub:/usr/bin:/bin" \
  node dist/cli/cos.js ui --port 4790 --no-open &)
sleep 3
curl -s localhost:4790/api/memory                       # history.on false, fix install-tools
curl -s -X POST -d '{"text":"still saved"}' localhost:4790/api/wrap    # {"ok":true}
cat "$T"/selfhub/journal/*.md                           # the note is there
```

Run from `/tmp`, and note `node dist/cli/cos.js` needs the repo path in front of it.

### The keys window

One window, one field per provider, driven by the server so adding a provider to the registry
adds a row with no Swift change. What it does:

| Behaviour | Why |
|---|---|
| Checks the key with one live request as it saves | a wrong key is caught now, not mid-conversation |
| Saves even when the check fails, and says what the provider said | nobody is stranded offline or behind a proxy |
| Starts using that provider when nothing else answers | one paste and it works, no model picking |
| Shows only a mask (`sk-ant…4f2a`), never the key | the window is safe to have open |
| Warns when the same variable comes from the shell | otherwise a save looks ignored |
| Rejects a paste that has whitespace, is too short, or is the placeholder | the usual bad pastes, named plainly |

Verify it without the app: `npx vitest run tests/keys.test.ts`, or against a built bundle,

```bash
APP=".build/package/Chief of Staff.app"
FRESH=$(mktemp -d)
(cd /tmp && env -i HOME="$FRESH" COS_HOME="$FRESH/.cos" PATH=/usr/bin:/bin   "$APP/Contents/Helpers/node" "$APP/Contents/Resources/runtime/dist/cli/cos.js" ui --port 4796 --no-open &)
sleep 2
curl -s http://127.0.0.1:4796/api/keys      # ready: false, three rows, each with a keyUrl
```

Run that from `/tmp`, not the repo: inside the project folder the project's own `.env` is
copied to the home file, which is right in normal use and hides the empty state in a test.

## Recommendation

- **Now, for friends:** `npm run package`, send the .dmg with the five steps above. Keys are a
  window now, so nothing about setup needs a Terminal.
- **Before any customer:** the Developer Program and steps 1 to 3. One afternoon once the
  certificate exists; the packager is ready for it. Then a key pane (6), then universal (4).
