// Demo plugin client app. It only talks through the per-iframe MessageChannel.
const button = document.getElementById("tip");
const result = document.getElementById("result");

/** Reports the content's real height so the host never reserves empty space. */
function reportSize(port, token) {
  const report = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    port.postMessage({ type: "resize", token, height });
  };
  report();
  new ResizeObserver(report).observe(document.body);
}

const bridgeReady = new Promise((resolve) => {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "bulletin:bridge:init") {
      return;
    }

    const port = event.ports[0];

    if (port === undefined || typeof event.data.token !== "string") {
      return;
    }

    let nextId = 0;
    const pending = new Map();
    port.onmessage = (message) => {
      const value = message.data;
      if (value?.type !== "bulletin:bridge:result" || value.token !== event.data.token) {
        return;
      }
      pending.get(value.id)?.(value);
      pending.delete(value.id);
    };
    port.start();

    const call = (body) =>
      new Promise((done) => {
        const id = `tip-${String(++nextId)}`;
        pending.set(id, done);
        port.postMessage({ ...body, token: event.data.token, id });
      });

    resolve({ call, port, token: event.data.token });
    reportSize(port, event.data.token);
  });
});

/** Calls the plugin's own route; the host records the viewer-aware answer on the frame. */
async function tip() {
  const bridge = await bridgeReady;
  return bridge.call({ type: "route", path: "tip", method: "GET" });
}

button.addEventListener("click", () => {
  void tip().then((response) => {
    result.textContent = response?.data?.body ? "Thanks!" : "";
  });
});
void tip();
