# Real-device acceptance checklist

This is the manual release gate required by [ADR 0015](../adr/0015-testing.md) and
[ADR 0014](../adr/0014-mobile-pwa.md). It is run by a person on **one physical iPhone and one
physical Android phone before every release**. An automated agent cannot complete it by running
emulators or `Bun.WebView`: install prompts, the iOS home-screen PWA, OS notification delivery
and real mobile keyboards behave differently on a device. Writing this document is the agent's
whole task; the boxes are ticked only by the person running the release.

Record the result for both devices. Any failed install, push, offline or editor-input item is a
release blocker; file the defect and link it below. Do not mark a device passed by skipping an
item — mark it **N/A** only where the OS genuinely cannot support the feature (for example Web
Push on an iOS version older than 16.4).

## 1. Before starting

- [ ] Release candidate is deployed to the staging/production-like environment and the exact
      version is recorded below. The service worker version shown by `/sw.js?v=<build>` matches
      the deployed build.
- [ ] Two member accounts are available: **Recipient** (the device being tested) and **Sender**
      (a second browser/account used to trigger topics, replies, reactions and PMs).
- [ ] A test forum and topic are available. Use only test content; do not send release-test
      notifications to real members.
- [ ] Both devices use current stable OS/browser versions. The iOS device must be on iOS/iPadOS
      **16.4 or newer** for Web Push in an installed home-screen app.
- [ ] On each device, remove any previously installed copy of the app, reset the browser's
      notification permission for the site, sign out of the test account, and clear website
      data. This makes "Enable push" and first install deterministic.
- [ ] Decide the language for the run. Test at least English and one of Spanish/French on one
      device; verify the offline page, push notification title and device-list UI are translated
      (no raw keys such as `push.title.*`).

## 2. Installability

| # | Step | Expected |
|---|---|---|
| 2.1 | Open the user app in the device browser at a **360 CSS-pixel-wide portrait viewport**. | Page is usable without horizontal scrolling; text and controls are readable; touch targets are at least 44 px. |
| 2.2 | Android: use Chrome's **Install app** prompt or menu. iOS: **Share → Add to Home Screen**. | The install action is offered and completes without an error. |
| 2.3 | Read the installed app's name and icon. | Name and icon match the board and the active theme; no generic browser icon or placeholder text. |
| 2.4 | Launch the installed app from the home screen. | Opens directly to the board index in standalone mode (no browser address bar) and is already signed in if the same profile was signed in. |
| 2.5 | While the installed app is open, deploy a new build (or use the release candidate's second build), then navigate to another page. | The next navigation loads the new HTML/assets; no stale-script errors, blank page or mixed old/new chrome. |
| 2.6 | Open the installed app with the network disabled. | The translated offline page/shell appears (see Offline). |

## 3. Push notifications

Push is per-device and per-type. The encrypted push payload must contain only a notification
reference and a generic title key. The device may fetch a preview after authenticating, so the
shown notification can contain the topic/conversation title, but never the post body, quoted
text or private-message body.

### 3.1 Enable and list the device

| # | Step | Expected |
|---|---|---|
| 3.1.1 | In the installed app, open **Account → Notifications → Preferences**. | The push settings section is visible, including the registered-device list. |
| 3.1.2 | Tap **Enable on this device** and grant the OS notification permission. | The device appears in the list with a label, browser family, added date and last-used/never-used state. |
| 3.1.3 | Inspect the device list and the page source/network response. | The list shows only label/browser/date metadata. It never shows an endpoint URL, `p256dh` key or auth secret. |
| 3.1.4 | Repeat 3.1.1–3.1.3 on the other OS. | Both devices can be registered independently. |

### 3.2 Delivery, preferences and content

| # | Step | Expected |
|---|---|---|
| 3.2.1 | Enable push only for **Private messages**; leave other types off. From Sender, send Recipient a PM. | Recipient receives a push on the device. Its title is a generic localised "New message"; the notification does not contain the message body. |
| 3.2.2 | Tap the PM push while signed in. | The app opens the correct conversation, not the board index or a blank page. |
| 3.2.3 | From Sender, react to one of Recipient's posts. | No push arrives for the reaction while its push preference is off. |
| 3.2.4 | Enable push for replies/reactions, then trigger one of each. | Each enabled type produces a push; disabled types remain silent. |
| 3.2.5 | Inspect the push payload (for example in `mocks/push` or the service-worker network panel), then expand the notification while signed in and again while signed out. | The payload contains only `{n,t}`: a notification reference and a generic title key — no post body, topic title, quoted text or member name. While signed in the app may show the fetched topic/conversation title; while signed out it shows only the generic localised title. |
| 3.2.6 | Sign out (or revoke Recipient's session from another browser), then trigger a push and tap it. | The app opens the login page with a return path, not a private page; after signing in, Recipient reaches the referenced content. |
| 3.2.7 | Remove the device from the registered-device list, then trigger a PM. | No further push arrives on that device; the list no longer shows it. Re-enabling registers it again. |

**iOS note:** Web Push requires the app to be installed to the home screen and the member to
grant permission from inside the installed app. A Safari tab is not a supported push target;
record that as expected, not a failure.

## 4. Offline behaviour and drafts

| # | Step | Expected |
|---|---|---|
| 4.1 | Browse a forum, a topic and a PM while online, then enable airplane mode and open a different topic from the installed app. | The translated offline page/shell appears. No topic title, post, profile or conversation content is shown from a cache. |
| 4.2 | With airplane mode still on, use the browser back/forward or the app's navigation. | The app never serves stale forum content; it remains on the offline shell or shows a network error. |
| 4.3 | Turn airplane mode off and retry. | The requested page loads normally. |
| 4.4 | Open a reply or new-topic editor, type a unique draft, enable airplane mode and submit. | The draft is saved on the device and the reconnect prompt appears; the page does not silently lose the text. |
| 4.5 | Turn airplane mode off and wait for the connection-restored prompt. | The prompt offers to send the saved draft; the send control is enabled only after connectivity returns. |
| 4.6 | Confirm sending. | The post appears in the correct topic/conversation. The saved draft is cleared and the prompt disappears. |
| 4.7 | Sign out, or have staff revoke the session while the app is open; then relaunch. | Local drafts are cleared and the app shows the logged-out state. A later account cannot see the previous member's draft. |
| 4.8 | Repeat the draft/reconnect flow on the other OS. | The same behaviour holds on iOS and Android. |

## 5. Editor input on mobile

Use the real on-screen keyboard, not a desktop browser resized to a phone width.

| # | Step | Expected |
|---|---|---|
| 5.1 | Open a reply or new-topic form in portrait at 360 px wide. | The editor is fully visible and usable; the keyboard opens on focus; the page does not zoom or scroll horizontally. |
| 5.2 | Type several lines, including an accented character (`é`, `ñ`, `ç`), an emoji and a pasted sentence. | All text is entered correctly; the caret stays visible above the keyboard; no characters are dropped. |
| 5.3 | Switch between **WYSIWYG** and **Source** modes. | Content and line breaks are preserved; the editor remains focused and usable. |
| 5.4 | Apply bold, italic, heading, quote, list, code and spoiler formatting; open the emoticon picker and insert an emoticon. | Formatting produces the expected Markdown/rendered result; the toolbar and picker are reachable without a mouse. |
| 5.5 | Type `@` and choose a mentioned member (if enabled). | Autocomplete works with the mobile keyboard and inserts the mention correctly. |
| 5.6 | Wait for autosave, reload the page, and reopen the editor. | The saved draft is offered and can be restored; restoring does not duplicate text. |
| 5.7 | Submit the post online. | The post renders correctly in the topic/conversation and the draft is cleared. |
| 5.8 | Rotate the device while the editor is open, then rotate back. | The editor, toolbar and submit control remain usable and no text is lost. |
| 5.9 | On iOS, exercise the keyboard's Done/return and keyboard-dismiss behaviour. On Android, exercise the system Back button and long-press paste. | The keyboard dismisses without losing input; Back does not accidentally submit or leave the page; paste inserts at the caret. |

## 6. Release decision

| Field | Value |
|---|---|
| Release version / commit | |
| Deployed build / worker version | |
| Test date | |
| Tester | |
| iOS device / OS / Safari version | |
| Android device / OS / Chrome version | |
| Languages tested | |

| Section | iOS result | Android result | Defect link / notes |
|---|---|---|---|
| Installability | Pass / Fail / N/A | Pass / Fail / N/A | |
| Push | Pass / Fail / N/A | Pass / Fail / N/A | |
| Offline and drafts | Pass / Fail / N/A | Pass / Fail / N/A | |
| Editor input | Pass / Fail / N/A | Pass / Fail / N/A | |

**Ship / block decision:** ____________________

All install, push, offline and editor-input items must pass on both devices before the release
is approved. If the iOS device cannot run a current OS with Web Push support, record the
limitation and do not treat the push section as passed.
