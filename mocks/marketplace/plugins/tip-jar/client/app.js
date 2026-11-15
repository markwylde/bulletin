// Sandboxed tip-jar client app. It talks only through the per-iframe MessageChannel.
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

new Promise((resolve) => {
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "bulletin:bridge:init") {
      return;
    }

    const port = event.ports[0];
    if (port === undefined || typeof event.data.token !== "string") {
      return;
    }

    port.start();
    reportSize(port, event.data.token);
    resolve({ port, token: event.data.token });
  });
}).then((bridge) => {
  button.addEventListener("click", () => {
    bridge.port.postMessage({
      type: "toast",
      token: bridge.token,
      messageKey: "plugin.tips.thanks",
    });
    result.textContent = "✓";
  });
});
