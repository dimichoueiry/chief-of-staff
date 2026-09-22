# Installing Chief of Staff

For someone who was handed the app as a `.dmg` file. No Terminal, no coding.

If you want to build it from the source code instead, see [Developer install](#developer-install) at the end.

## Before you start

| You need | Details |
|---|---|
| A Mac with **Apple silicon** (M1 or newer) | The current download is built for Apple silicon only. The file name says so: `Chief-of-Staff-<version>-arm64.dmg`. It will not open on an Intel Mac. |
| **macOS 14 Sonoma or newer** | The app will not open on older versions. |
| About **200 MB** of free space | The download itself is about 120 MB. |
| **An API key** from an AI provider | Anthropic, OpenAI or OpenRouter. You create it and you pay for it. See [Step 4](#4-add-your-api-key). |
| **Google Chrome** or **Microsoft Edge** (optional) | Only for the assistant's own browser. Everything else works without one. |

To check your Mac: Apple menu  › **About This Mac**. "Chip: Apple M…" means Apple silicon, and the macOS version is listed under it.

## 1. Install

1. Open the `.dmg` file.
2. Drag **Chief of Staff** into the **Applications** folder.
3. Eject the disk image (drag it to the Trash, or right-click › Eject).

## 2. Open it the first time

This build is **not notarized by Apple**. It is signed with a local certificate, not an Apple Developer ID. So the first time you open it, macOS says it can't verify the developer. That is expected. Only continue if you trust the person who gave you the file.

1. Open **Chief of Staff** from Applications. When the warning appears, click **Done** (or **Cancel**). Don't move it to the Trash.
2. Open **System Settings › Privacy & Security**, scroll down to the Security section, and click **Open Anyway** next to Chief of Staff.
3. Confirm with your password or Touch ID, then click **Open**.

You only do this once. macOS remembers the choice for this copy of the app.

On macOS 14 you can also right-click the app in Applications › **Open** › **Open**.

Chief of Staff lives in the menu bar, not the Dock. Look for the **✦** icon at the top right of the screen. If the notch hides it, press **⌥ Space** (Option-Space) and click the ✦ inside the bar that appears: it's the same menu.

## 3. Allow what it asks for

When it opens, it checks five macOS permissions and walks you through the ones that are off, one at a time. Each one only turns on a feature. Say no, and that feature stays off.

| Permission | What it's for | Needed? |
|---|---|---|
| **Accessibility** | Hold or double-tap Control from any app to talk | For voice shortcuts |
| **Microphone** | Hearing you | For voice |
| **Speech Recognition** | Turning what you say into text | For voice |
| **Screen & System Audio Recording** | "Look at this": it reads what's on your screen when you ask | Optional |
| **Full Disk Access** | Opening your browser bookmarks | Optional |

macOS has no pop-up for Full Disk Access, so the app opens the right settings page and shows itself in Finder for you to drag into the list.

**Calendar** is asked separately, the first time it reads your calendar. It only reads events, to plan around your free time. It never changes them.

You can review these any time under **✦ › Permissions**. Click one that's off to set it up.

## 4. Add your API key

Chief of Staff doesn't come with an AI account. It uses yours.

- **You create the key** with a provider, and **the provider bills you** for what it uses. Set a spending limit in the provider's dashboard if you want one.
- **Keep the key private.** Anyone who has it can spend on your account.

The app asks for a key on first launch. It's always under **✦ › API keys…**: one field per provider, each with a **Get a key** link.

| Provider | Where to get a key |
|---|---|
| Anthropic (Claude) | console.anthropic.com |
| OpenAI | platform.openai.com/api-keys |
| OpenRouter (many models, one key) | openrouter.ai/keys |

One key is enough. Paste it and the window checks it with the provider as it saves. If the check fails, it still saves the key and tells you what the provider said.

Where it's stored: a file on this Mac only you can read (`~/.cos/.env`). The window only ever shows a masked version of it.

Without any key, the basic morning brief and reminders still work. Conversation doesn't.

## 5. Try it

- Press **⌥ Space** and type a question, such as "what should I focus on today?"
- Or **hold Control**, speak, and let go.
- **✦ › Open at login** starts it with your Mac.

Your notes, projects and journal are plain text files in a folder called `selfhub` in your home folder. The app creates it the first time it runs. **✦ › Memory** shows where it is.

**✦ › Memory** may say history is off. That means Apple's free command line developer tools aren't installed. Your notes are still saved. The tools only add an undo history. **Turn history on…** in that menu installs them.

### The assistant's own browser

To do things on websites for you, it opens a separate Chrome (or Edge) window with its own profile. Your everyday browser and its passwords are never touched.

- Chrome or Edge must be installed. Without one, this feature is off.
- The first time a site needs you to sign in, you sign in yourself in that window. It never types passwords or codes.
- It asks before using a new site, and before anything that sends, submits, buys, posts or deletes.

## Troubleshooting

| Problem | What to do |
|---|---|
| "Chief of Staff is damaged" or "can't be opened" | Follow [Step 2](#2-open-it-the-first-time). If there's no **Open Anyway** button, open the app once more and check Privacy & Security again. |
| It won't open at all on an Intel Mac or on macOS 13 | Not supported by this build. See [Before you start](#before-you-start). |
| No ✦ in the menu bar | The notch may be hiding it. Press **⌥ Space** and use the ✦ inside the bar. |
| Control does nothing | Turn on **Accessibility** under ✦ › Permissions. |
| A permission is on, but the feature still says it's blocked | In System Settings › Privacy & Security, select Chief of Staff in that list, remove it with **−**, add it back with **+**, then quit and reopen the app. |
| "No model" or "no key" replies | Add a key under ✦ › API keys…. If the check says the key is wrong, copy it again from the provider. Pasting extra spaces is the usual cause. |
| The key check fails but you're sure the key is right | Check your internet connection and the provider's billing page. A new account often needs a payment method first. |
| The browser feature is off | Install Google Chrome or Microsoft Edge, then quit and reopen the app. |
| Calendar is empty | Allow Calendar in System Settings › Privacy & Security › Calendars. It reads the calendars the macOS Calendar app shows. |
| Anything else | Quit (✦ › Quit Chief of Staff) and reopen. If it still fails, send the person who gave you the app the file `~/.cos/logs/menubar.log`. |

To open a folder that starts with `~`: in Finder, **Go › Go to Folder…** (⇧⌘G) and paste the path. `~` means your home folder.

## Uninstall and remove your data

**✦ › Remove Chief of Staff…** does most of it. It:

- quits the app and stops it opening at login
- moves the app to the Trash
- moves `~/.cos` to the Trash: settings, **your API keys**, logs, and the assistant's browser profile with its sign-ins

It does **not** touch your memory folder. Your notes, projects and journal are yours, and it's the only copy.

To remove everything:

1. **Your memory:** drag `~/selfhub` to the Trash, if you no longer want your notes. (✦ › Memory shows the path if you changed it.)
2. **Permissions:** in System Settings › Privacy & Security, remove Chief of Staff from each list you added it to (Accessibility, Microphone, Speech Recognition, Screen & System Audio Recording, Full Disk Access, Calendars).
3. **Login item:** check System Settings › General › Login Items and remove it if it's still listed.
4. **API keys:** deleting the app doesn't cancel your keys. Revoke them in the provider's dashboard if you won't use them again.
5. Empty the Trash.

If the app is already gone, delete these by hand: `/Applications/Chief of Staff.app`, `~/.cos`, and, if you want, `~/selfhub`.

## Developer install

Everything above is for the `.dmg`. Building from source is a different install, for people working on the code:

- It needs Node 20+, Xcode command line tools, and a clone of the repository.
- `npm run cos -- menubar install` builds `~/Applications/Chief of Staff.app`. That app is a thin shell that runs the code from your Mac's Node. You can't hand it to someone else.
- `npm run package` makes the self-contained `.app` and `.dmg` described in this guide.

See the [README quick start](../README.md#quick-start) and [the desktop app](../README.md#the-desktop-app) for the developer setup. [DISTRIBUTION.md](DISTRIBUTION.md) covers packaging, signing, and what's still needed before a notarized release.
