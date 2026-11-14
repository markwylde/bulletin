import { describe, expect, test } from "bun:test";
import { PUSH_TEST_KEYS } from "@bulletin/mock-push/test-keys";
import {
  clickSelector,
  loginAs,
  waitForExpression,
  waitForSelector,
  waitForText,
  withPage,
} from "@bulletin/test-utils/e2e";
import { userBaseUrl } from "@bulletin/test-utils/urls";
import { setFlagRules } from "./support/flags.ts";

// Run against the full stack:
//   docker compose up -d --build --wait
//   bun run test:e2e

const ENABLED = Bun.env.BULLETIN_E2E === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;
const USER_URL = userBaseUrl();
const ORIGIN = new URL(USER_URL).origin;

interface PushMessage {
  readonly body: { readonly n?: string; readonly t?: string };
}

interface NotificationView {
  readonly title: string;
  readonly body: string;
  readonly data: { readonly url?: string; readonly loginRequired?: boolean };
}

integrationDescribe("push", () => {
  test("enables this device through the permission and subscription flow, then removes it", async () => {
    await withPage(
      { url: `${USER_URL}/account/notifications/preferences`, viewport: "mobile360" },
      async (view) => {
        await viewGrantNotifications(view);
        await loginAs(view, "member-1");
        await waitForSelector(view, "[data-push-settings]");
        await waitForSelector(view, "[data-push-enable]:not([hidden])");
        const before = await view.evaluate<number>(
          "document.querySelectorAll('[data-push-device]').length",
        );

        // The push service itself is not reachable from headless Chrome; the browser
        // subscription object is the only part mocked, while permission, the enable button,
        // the save API and the refreshed device list all run for real.
        const prepared = await view.evaluate<boolean>(`(() => {
          if (!("PushManager" in window)) return false;
          const subscription = {
            endpoint: "http://push:4003/push/e2e-enable",
            toJSON: () => ({
              endpoint: "http://push:4003/push/e2e-enable",
              keys: { p256dh: ${JSON.stringify(PUSH_TEST_KEYS.publicKey)}, auth: ${JSON.stringify(PUSH_TEST_KEYS.auth)} }
            })
          };
          PushManager.prototype.getSubscription = async () => null;
          PushManager.prototype.subscribe = async () => subscription;
          return true;
        })()`);
        expect(prepared).toBe(true);

        await waitForSelector(view, "[data-push-enable]:not([disabled])");
        await clickSelector(view, "[data-push-enable]");
        await waitForExpression(
          view,
          `document.querySelectorAll("[data-push-device]").length === ${before + 1}`,
          20_000,
        );
        await waitForText(view, "Push is enabled on this device.");

        const page = await view.evaluate<string>("document.documentElement.outerHTML");
        expect(page).not.toContain("push/e2e-enable");
        expect(page).not.toContain(PUSH_TEST_KEYS.publicKey);
        expect(page).not.toContain(PUSH_TEST_KEYS.auth);

        const removed = await view.evaluate<boolean>(`(() => {
          const row = [...document.querySelectorAll("[data-push-device]")].find((candidate) => !candidate.textContent?.includes("Seed phone"));
          const button = row?.querySelector("[data-push-remove]");
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
          button.click();
          return true;
        })()`);
        expect(removed).toBe(true);
        await waitForExpression(
          view,
          `document.querySelectorAll("[data-push-device]").length === ${before}`,
          20_000,
        );
        await waitForText(view, "Device removed.");
      },
    );
  }, 180_000);

  test("shows an authenticated push preview from the mock and opens the conversation", async () => {
    const title = `Push E2E ${Date.now()}`;
    let conversationId = "";

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await loginAs(view, "member-2");
      const recipient = await view.evaluate<{ readonly id: string } | null>(
        `fetch("/api/members/suggest?q=Regular", { headers: { accept: "application/json" } })
          .then((response) => response.json())
          .then((body) => body.members?.find((member) => member.displayName === "Regular Member One") ?? null)`,
      );

      if (recipient === null) {
        throw new Error("The seeded member-1 recipient was not found");
      }

      const created = await view.evaluate<{ status: number; body: string }>(`(async () => {
        const session = await fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json());
        const response = await fetch("/api/conversations", {
          method: "POST",
          headers: { "content-type": "application/json", "x-bulletin-csrf": session.csrfToken },
          body: JSON.stringify({ title: ${JSON.stringify(title)}, bodyMd: "A push preview message.", recipientIds: [${JSON.stringify(recipient?.id ?? "")}] })
        });
        return { status: response.status, body: await response.text() };
      })()`);
      expect(created.status).toBe(200);
      conversationId =
        (JSON.parse(created.body) as { conversationId?: string }).conversationId ?? "";
      expect(conversationId).toMatch(/^\d+$/);
    });

    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await viewGrantNotifications(view);
      await loginAs(view, "member-1");
      const memberId = await view.evaluate<string>(
        'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json()).then((body) => body.memberId)',
      );
      expect(memberId).toMatch(/^\d+$/);

      let notification: { readonly id: string; readonly href: string } | null = null;
      for (let attempt = 0; attempt < 20 && notification === null; attempt += 1) {
        await view.navigate(`${USER_URL}/account/notifications`);
        await Bun.sleep(500);
        notification = await view.evaluate<{ id: string; href: string } | null>(`(() => {
          const link = [...document.querySelectorAll("[data-notification-link]")].find((candidate) => candidate.getAttribute("href") === ${JSON.stringify(`/conversations/${conversationId}`)});
          if (!(link instanceof HTMLAnchorElement)) return null;
          return { id: link.getAttribute("data-notification-link") ?? "", href: link.getAttribute("href") ?? "" };
        })()`);
      }

      if (notification === null) {
        throw new Error("No notification for the push");
      }

      const captured = await view.evaluate<PushMessage | null>(`(async () => {
        await fetch("/_mocks/push/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ n: ${JSON.stringify(notification.id)}, t: "push.title.conversation" })
        });
        const messages = await fetch("/_mocks/push/api/messages").then((response) => response.json());
        return messages[0] ?? null;
      })()`);

      if (captured === null) {
        throw new Error("The push mock captured nothing");
      }

      expect(captured.body).toEqual({
        n: notification.id,
        t: "push.title.conversation",
      });

      await deliverPush(view, captured.body);
      await Bun.sleep(1_000);

      await waitForExpression(
        view,
        `navigator.serviceWorker.getRegistration().then((registration) => registration.getNotifications()).then((notifications) => notifications.some((notification) => notification.data?.notificationId === ${JSON.stringify(notification.id)}))`,
        20_000,
      );
      const shown = await view.evaluate<NotificationView[]>(
        `navigator.serviceWorker.getRegistration().then((registration) => registration.getNotifications()).then((notifications) => notifications.filter((notification) => notification.data?.notificationId === ${JSON.stringify(notification.id)}).map((notification) => ({ title: notification.title, body: notification.body, data: notification.data })))`,
      );
      expect(shown[0]?.title).toBe("New message");
      expect(shown[0]?.body).toBe(title);
      expect(shown[0]?.data.url).toBe(notification.href);
      expect(shown[0]?.data.loginRequired).toBe(false);

      // Clicking the real notification rechecks authentication and opens the destination.
      await clickNotification(view, shown[0]?.data ?? {});
      await waitForExpression(
        view,
        `location.pathname === ${JSON.stringify(notification.href)}`,
        20_000,
      );
    });
  }, 300_000);
  test("marks a guest push for the login fallback", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await viewGrantNotifications(view);
      const payload = { n: "987654", t: "push.title.generic" };
      const captured = await view.evaluate<PushMessage | null>(`(async () => {
        await fetch("/_mocks/push/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(${JSON.stringify(payload)})
        });
        const messages = await fetch("/_mocks/push/api/messages").then((response) => response.json());
        return messages[0] ?? null;
      })()`);

      if (captured === null) {
        throw new Error("The push mock captured nothing");
      }

      await deliverPush(view, captured.body);
      await Bun.sleep(1_000);
      await waitForExpression(
        view,
        `navigator.serviceWorker.getRegistration().then((registration) => registration.getNotifications()).then((notifications) => notifications.some((notification) => notification.data?.notificationId === "987654"))`,
        20_000,
      );
      const shown = await view.evaluate<NotificationView[]>(
        `navigator.serviceWorker.getRegistration().then((registration) => registration.getNotifications()).then((notifications) => notifications.filter((notification) => notification.data?.notificationId === "987654").map((notification) => ({ title: notification.title, body: notification.body, data: notification.data })))`,
      );
      expect(shown[0]?.title).toBe("Bulletin notification");
      expect(shown[0]?.data.loginRequired).toBe(true);
      expect(shown[0]?.data.url).toBe("/account/notifications?open=987654");

      await clickNotification(view, shown[0]?.data ?? {});
      await waitForSelector(view, "[data-login]", 20_000);
    });
  }, 300_000);

  test("uses the member's locale for push titles even when the browser is English", async () => {
    await withPage({ url: USER_URL, viewport: "mobile360" }, async (view) => {
      await viewGrantNotifications(view);
      await loginAs(view, "member-fr");
      expect(await view.evaluate<string>("document.documentElement.lang")).toBe("fr");

      await view.navigate(`${USER_URL}/account/notifications`);
      await waitForSelector(view, "[data-notification-link]", 30_000);
      const notification = await view.evaluate<{ id: string } | null>(`(() => {
        const link = [...document.querySelectorAll("[data-notification-link]")].find((candidate) => (candidate.getAttribute("href") ?? "").includes("/topic/"));
        if (!(link instanceof HTMLAnchorElement)) return null;
        return { id: link.getAttribute("data-notification-link") ?? "" };
      })()`);

      if (notification === null) {
        throw new Error("No topic notification for member-fr");
      }

      const preview = await view.evaluate<{ readonly t?: string } | null>(
        `fetch("/api/notifications/${notification.id}/preview", { credentials: "include" }).then((response) => response.ok ? response.json() : null)`,
      );

      if (preview?.t === undefined) {
        throw new Error("Missing push preview for member-fr");
      }

      const expectedTitle =
        preview.t === "push.title.topicCreated" ? "Nouveau sujet" : "Nouvelle réponse";
      await waitForExpression(
        view,
        `navigator.serviceWorker.ready.then((registration) => registration.active?.scriptURL.includes("l=fr") ?? false)`,
        30_000,
      );
      await deliverPush(view, { n: notification.id, t: preview.t });
      await Bun.sleep(1_000);
      await waitForExpression(
        view,
        `navigator.serviceWorker.getRegistration().then((registration) => registration.getNotifications()).then((notifications) => notifications.some((notification) => notification.data?.notificationId === ${JSON.stringify(notification.id)}))`,
        20_000,
      );
      const shown = await view.evaluate<NotificationView[]>(
        `navigator.serviceWorker.getRegistration().then((registration) => registration.getNotifications()).then((notifications) => notifications.filter((notification) => notification.data?.notificationId === ${JSON.stringify(notification.id)}).map((notification) => ({ title: notification.title, body: notification.body, data: notification.data })))`,
      );
      expect(shown[0]?.title).toBe(expectedTitle);
    });
  }, 300_000);
  test("does not render push settings when pwa is off even though web_push is on", async () => {
    const offRules = [{ type: "group", groups: ["members"], value: false }];

    try {
      await setFlagRules("pwa", offRules);

      await withPage(
        { url: `${USER_URL}/account/notifications/preferences`, viewport: "mobile360" },
        async (view) => {
          await loginAs(view, "member-1");
          await waitForSelector(view, "[data-notification-preferences-page]");
          expect(
            await view.evaluate<number>("document.querySelectorAll('[data-push-settings]').length"),
          ).toBe(0);
          expect(
            await view.evaluate<number>("document.querySelectorAll('[data-push-enable]').length"),
          ).toBe(0);
          expect(
            await view.evaluate<boolean>(
              `document.documentElement.dataset.clientFlags?.includes('"pwa":true') ?? false`,
            ),
          ).toBe(false);
        },
      );
    } finally {
      await setFlagRules("pwa", []);
    }
  }, 300_000);
  test("lists and removes devices in a browser without PushManager", async () => {
    await withPage(
      { url: `${USER_URL}/account/notifications/preferences`, viewport: "mobile360" },
      async (view) => {
        await loginAs(view, "member-1");
        await waitForSelector(view, "[data-push-settings]");

        const session = await view.evaluate<{ csrfToken: string }>(
          'fetch("/api/auth/session", { headers: { accept: "application/json" } }).then((response) => response.json())',
        );
        const subscribed = await view.evaluate<boolean>(`fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json", "x-bulletin-csrf": ${JSON.stringify(session.csrfToken)} },
          body: JSON.stringify({
            endpoint: "http://push:4003/push/e2e-unsupported",
            keys: { p256dh: ${JSON.stringify(PUSH_TEST_KEYS.publicKey)}, auth: ${JSON.stringify(PUSH_TEST_KEYS.auth)} },
            label: "Unsupported browser device"
          })
        }).then((response) => response.ok)`);
        expect(subscribed).toBe(true);

        await view.cdp("Page.addScriptToEvaluateOnNewDocument", {
          source: "delete window.PushManager; delete globalThis.PushManager;",
        });
        await view.navigate(`${USER_URL}/account/notifications/preferences`);
        await waitForSelector(view, "[data-push-settings]");
        expect(await view.evaluate<boolean>('"PushManager" in window')).toBe(false);
        await waitForText(view, "Unsupported browser device");
        expect(
          await view.evaluate<boolean>(
            "document.querySelector('[data-push-enable]')?.hidden === true",
          ),
        ).toBe(true);

        const removed = await view.evaluate<boolean>(`(() => {
          const row = [...document.querySelectorAll("[data-push-device]")].find((candidate) => candidate.textContent?.includes("Unsupported browser device"));
          const button = row?.querySelector("[data-push-remove]");
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
          button.click();
          return true;
        })()`);
        expect(removed).toBe(true);
        await waitForExpression(
          view,
          `[...document.querySelectorAll("[data-push-device]")].every((row) => !row.textContent?.includes("Unsupported browser device"))`,
          20_000,
        );
      },
    );
  }, 180_000);
});

/** Dispatches a real notificationclick event inside the active service worker. */
async function clickNotification(view: Bun.WebView, data: Record<string, unknown>): Promise<void> {
  let sessionId = "";
  view.addEventListener<{
    readonly sessionId?: string;
    readonly targetInfo?: { readonly type?: string; readonly url?: string };
  }>("Target.attachedToTarget", (event) => {
    if (
      event.data.sessionId !== undefined &&
      event.data.targetInfo?.type === "service_worker" &&
      (event.data.targetInfo.url ?? "").includes("bulletin.localhost")
    ) {
      sessionId = event.data.sessionId;
    }
  });
  await view.cdp("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: false,
  });
  await Bun.sleep(250);

  if (sessionId === "") {
    throw new Error("Chrome did not expose the service worker target");
  }

  const expression = `(async () => {
    const event = new Event("notificationclick");
    event.notification = { close() {}, data: ${JSON.stringify(data)} };
    event.waitUntil = (work) => { self.__bulletinClick = work; };
    self.dispatchEvent(event);
    if (self.__bulletinClick) await self.__bulletinClick;
    return true;
  })()`;

  await view.cdp("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  });
}

/** Headless Chrome denies notifications unless the browser target grants the origin. */
async function viewGrantNotifications(view: Bun.WebView): Promise<void> {
  await view.cdp("Browser.grantPermissions", {
    origin: ORIGIN,
    permissions: ["notifications"],
  });
}

async function deliverPush(view: Bun.WebView, payload: unknown): Promise<void> {
  let registrationId = "";
  view.addEventListener<{
    readonly registrations?: readonly {
      readonly registrationId?: string;
      readonly scopeURL?: string;
    }[];
  }>("ServiceWorker.workerRegistrationUpdated", (event) => {
    for (const registration of event.data.registrations ?? []) {
      if ((registration.scopeURL ?? "").startsWith(ORIGIN)) {
        registrationId = registration.registrationId ?? "";
      }
    }
  });
  await view.cdp("ServiceWorker.enable");
  await waitForExpression(
    view,
    "navigator.serviceWorker.getRegistrations().then((items) => items.length > 0)",
    30_000,
  );
  await view.evaluate(
    "navigator.serviceWorker.ready.then((registration) => registration.active !== null)",
  );
  await Bun.sleep(500);

  if (registrationId === "") {
    throw new Error("Chrome did not expose the service worker registration id");
  }

  await view.cdp("ServiceWorker.deliverPushMessage", {
    origin: ORIGIN,
    registrationId,
    data: JSON.stringify(payload),
  });
}
