/**
 * Header behaviour (ADR 0021): the phone navigation panel, the member menu and the current
 * section marker. The header HTML is shared and cached, so the current link is marked here
 * from the URL rather than in the template.
 */

const header = document.querySelector<HTMLElement>("[data-shell-header]");

function closeOnOutsideOrEscape(
  isOpen: () => boolean,
  close: (restoreFocus: boolean) => void,
  contains: (target: Node) => boolean,
): void {
  document.addEventListener("click", (event) => {
    if (isOpen() && event.target instanceof Node && !contains(event.target)) {
      close(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      close(true);
    }
  });
}

function setUpNavigation(container: HTMLElement): void {
  const toggle = container.querySelector<HTMLButtonElement>("[data-nav-toggle]");
  const panel = container.querySelector<HTMLElement>("[data-nav-panel]");

  if (toggle === null || panel === null) {
    return;
  }

  const isOpen = (): boolean => container.dataset.navOpen === "true";
  const setOpen = (open: boolean, restoreFocus = false): void => {
    container.dataset.navOpen = String(open);
    toggle.setAttribute("aria-expanded", String(open));

    if (!open && restoreFocus) {
      toggle.focus();
    }
  };

  toggle.addEventListener("click", () => {
    setOpen(!isOpen());

    if (isOpen()) {
      panel
        .querySelector<HTMLInputElement>("[data-quick-search-input]")
        ?.focus({ preventScroll: true });
    }
  });

  closeOnOutsideOrEscape(
    isOpen,
    (focus) => setOpen(false, focus),
    (target) => container.contains(target),
  );

  // Leaving the phone layout closes the panel so a desktop resize never shows it stuck open.
  window.matchMedia("(min-width: 48rem)").addEventListener("change", (query) => {
    if (query.matches) {
      setOpen(false);
    }
  });
}

function setUpAccountMenu(container: HTMLElement): void {
  const toggle = container.querySelector<HTMLButtonElement>("[data-account-menu-toggle]");
  const menu = container.querySelector<HTMLElement>("[data-account-menu]");

  if (toggle === null || menu === null) {
    return;
  }

  const items = (): HTMLElement[] =>
    [...menu.querySelectorAll<HTMLElement>("a[href], button")].filter(
      (item) => !item.hidden && item.closest("[hidden]") === null,
    );
  const isOpen = (): boolean => !menu.hidden;
  const setOpen = (open: boolean, restoreFocus = false): void => {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));

    if (!open && restoreFocus) {
      toggle.focus();
    }
  };

  toggle.addEventListener("click", () => {
    setOpen(!isOpen());
  });

  toggle.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      items()[0]?.focus();
    }
  });

  menu.addEventListener("keydown", (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  });

  closeOnOutsideOrEscape(
    isOpen,
    (focus) => setOpen(false, focus),
    (target) => toggle.contains(target) || menu.contains(target),
  );
}

/** Marks the primary navigation link for the current section with `aria-current`. */
function markCurrentSection(container: HTMLElement): void {
  const path = window.location.pathname;
  const section = (): string | null => {
    if (path === "/" || path.startsWith("/forum/") || path.startsWith("/topic/")) {
      return "forums";
    }

    if (path === "/members/online") {
      return "online";
    }

    if (path === "/members" || path.startsWith("/profile/")) {
      return "members";
    }

    if (path.startsWith("/leaderboards")) {
      return "leaderboards";
    }

    if (path === "/search/new") {
      return "new";
    }

    return null;
  };
  const current = section();

  if (current === null) {
    return;
  }

  for (const link of container.querySelectorAll<HTMLAnchorElement>(
    `[data-nav-link="${current}"]`,
  )) {
    link.setAttribute("aria-current", "page");
  }
}

if (header !== null) {
  setUpNavigation(header);
  setUpAccountMenu(header);
  markCurrentSection(header);
}
