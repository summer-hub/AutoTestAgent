window.__ModuleLoader__.load({
	id: "dsh-autotest",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	"use strict";
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __export = (target, all) => {
	  for (var name in all)
	    __defProp(target, name, { get: all[name], enumerable: true });
	};
	var __copyProps = (to, from, except, desc) => {
	  if (from && typeof from === "object" || typeof from === "function") {
	    for (let key of __getOwnPropNames(from))
	      if (!__hasOwnProp.call(to, key) && key !== except)
	        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
	  }
	  return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	
	// src/client/index.ts
	var index_exports = {};
	__export(index_exports, {
	  apply: () => apply,
	  inject: () => inject
	});
	module.exports = __toCommonJS(index_exports);
	var ENTRY_SELECTOR = "[data-dsh-autotest-entry]";
	var ACTIVE_ATTR = "data-dsh-autotest-active";
	var OTHER_ACTIVE_ATTRS = ["data-dsh-taskboard-active", "data-dsh-ssh-active"];
	var ACTIVATE_EVENT = "dsh-panel-activate";
	var PANEL_NAME = "autotest";
	var WEB_URL = "/autotest-web/";
	var STYLE_ID = "dsh-autotest-style";
	var CENTER_COLUMN_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]';
	var SIDEBAR_COLUMN_SELECTOR = '[data-pane="sidebar"], [class*="sidebarCol"]';
	var SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]';
	var ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2h6M6 2v3.2L3.4 10a2 2 0 0 0 1.7 3h5.8a2 2 0 0 0 1.7-3L10 5.2V2"/><path d="M5.5 9h5"/></svg>';
	var CSS = `
	.dsh-autotest-entry {
	  display: flex; align-items: center; gap: 8px; width: 100%; height: 32px;
	  padding: 0 12px; background: transparent; border: none; border-radius: 8px;
	  color: var(--dsw-alias-label-secondary, #aab3c4); cursor: pointer;
	  font-size: 13px; white-space: nowrap; font-family: var(--dsw-font-family, inherit);
	}
	.dsh-autotest-entry:hover {
	  background: var(--dsw-specific-sidebar-nav-item-hover, rgba(255,255,255,.06));
	  color: var(--dsw-alias-label-primary, #e8ebf2);
	}
	.dsh-autotest-entry[data-active] {
	  background: var(--dsw-specific-sidebar-nav-item-active, rgba(79,141,255,.14));
	  color: var(--dsw-alias-label-primary, #e8ebf2); font-weight: 600;
	}
	.dsh-autotest-entry-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; }
	[data-dsh-frame][data-sidebar-collapsed] .dsh-autotest-entry { justify-content: center; padding: 0; }
	[data-dsh-frame][data-sidebar-collapsed] .dsh-autotest-entry-label { display: none; }
	
	[data-pane='conversation'], [class*='centerCol'] { position: relative; }
	[data-dsh-autotest-view] {
	  position: absolute; inset: 0; display: none; z-index: 60;
	  background: var(--dsw-alias-bg-base, #0e1015);
	}
	html[data-dsh-autotest-active] [data-dsh-autotest-view] { display: block; }
	html[data-dsh-autotest-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [data-pane='conversation'] > :not([data-dsh-autotest-view]),
	html[data-dsh-autotest-active]:not([data-dsh-taskboard-active]):not([data-dsh-ssh-active]) [class*='centerCol'] > :not([data-dsh-autotest-view]) {
	  display: none !important;
	}
	.dsh-autotest-frame { width: 100%; height: 100%; border: 0; display: block; background: transparent; }
	`;
	var state = { open: false, listeners: /* @__PURE__ */ new Set() };
	function setOpen(next) {
	  if (state.open === next) return;
	  state.open = next;
	  if (next) {
	    for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr);
	    document.documentElement.setAttribute(ACTIVE_ATTR, "");
	    document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
	  } else {
	    document.documentElement.removeAttribute(ACTIVE_ATTR);
	  }
	  const entry = document.querySelector(ENTRY_SELECTOR);
	  if (entry !== null) {
	    if (state.open) entry.dataset.active = "true";
	    else delete entry.dataset.active;
	  }
	  for (const listener of state.listeners) listener();
	}
	function subscribe(listener) {
	  state.listeners.add(listener);
	  return () => state.listeners.delete(listener);
	}
	function ensureStyle() {
	  if (document.getElementById(STYLE_ID) !== null) return;
	  const style = document.createElement("style");
	  style.id = STYLE_ID;
	  style.textContent = CSS;
	  document.head.appendChild(style);
	}
	function sidebarRoot() {
	  const column = document.querySelector(SIDEBAR_COLUMN_SELECTOR);
	  if (column === null) return void 0;
	  const logoOwner = column.querySelector('[class*="logoRow"]')?.parentElement;
	  return logoOwner ?? column.firstElementChild;
	}
	function newSessionButton(root) {
	  const nested = root.querySelector('button[class*="newSession"]');
	  if (nested !== null) return nested;
	  for (const child of root.children) {
	    if (child.tagName === "BUTTON") return child;
	  }
	  return void 0;
	}
	function createEntry() {
	  const entry = document.createElement("button");
	  entry.type = "button";
	  entry.setAttribute("data-dsh-autotest-entry", "");
	  entry.setAttribute("data-dsh-plugin", "autotest");
	  entry.setAttribute("data-dsh-part", "sidebar-entry");
	  entry.className = "dsh-autotest-entry";
	  entry.setAttribute("aria-label", "AutoTest \u5E73\u53F0");
	  entry.setAttribute("title", "AutoTest \u5E73\u53F0 \u2014 \u9E3F\u8499\u4E09\u65B9\u5E93\u81EA\u52A8\u5316\u6D4B\u8BD5");
	  entry.innerHTML = `<span class="dsh-autotest-entry-icon">${ICON}</span><span class="dsh-autotest-entry-label">AutoTest \u5E73\u53F0</span>`;
	  entry.addEventListener("click", () => setOpen(!state.open));
	  return entry;
	}
	function mountSidebarEntry() {
	  if (typeof document !== "undefined" && document.querySelector(ENTRY_SELECTOR) !== null) return () => {
	  };
	  const entry = createEntry();
	  let placed = false;
	  const tryPlace = () => {
	    if (placed && document.body.contains(entry)) return;
	    if (!placed && entry.parentElement !== null) entry.remove();
	    const root = sidebarRoot();
	    if (root === void 0 || !root.isConnected) return;
	    const button = newSessionButton(root);
	    if (button === void 0) return;
	    if (entry.parentElement !== root) {
	      const row = button.closest('[class*="logoRow"]');
	      const anchor = (row !== null && row.parentElement === root ? row : button).nextElementSibling;
	      root.insertBefore(entry, anchor);
	    }
	    placed = true;
	  };
	  const observer = new MutationObserver(tryPlace);
	  observer.observe(document.body, { childList: true, subtree: true });
	  tryPlace();
	  return () => {
	    observer.disconnect();
	    entry.remove();
	  };
	}
	function centerColumn() {
	  return document.querySelector(CENTER_COLUMN_SELECTOR) ?? void 0;
	}
	function mountView() {
	  let container;
	  let observer;
	  const ensure = () => {
	    if (container !== void 0 && container.isConnected) return;
	    const column = centerColumn();
	    if (column === void 0) return;
	    if (container === void 0) {
	      container = document.createElement("div");
	      container.setAttribute("data-dsh-autotest-view", "");
	      container.setAttribute("data-dsh-plugin", "autotest");
	      const frame = document.createElement("iframe");
	      frame.className = "dsh-autotest-frame";
	      frame.title = "AutoTest \u5E73\u53F0";
	      frame.src = WEB_URL;
	      container.appendChild(frame);
	    }
	    column.appendChild(container);
	  };
	  observer = new MutationObserver(ensure);
	  observer.observe(document.body, { childList: true, subtree: true });
	  ensure();
	  const onOtherActivate = (event) => {
	    if (event.detail !== PANEL_NAME && state.open) setOpen(false);
	  };
	  const onClickSidebarRow = (event) => {
	    if (!state.open) return;
	    const target = event.target;
	    if (target !== null && target.closest(SIDEBAR_ROW_SELECTOR) !== null) setOpen(false);
	  };
	  document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
	  document.addEventListener("click", onClickSidebarRow, true);
	  const unsubscribe = subscribe(() => {
	  });
	  return () => {
	    observer?.disconnect();
	    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
	    document.removeEventListener("click", onClickSidebarRow, true);
	    unsubscribe();
	    document.documentElement.removeAttribute(ACTIVE_ATTR);
	    container?.remove();
	    container = void 0;
	  };
	}
	var inject = [];
	function apply(ctx) {
	  if (globalThis.__dshAutotestClientApplied === true) return;
	  globalThis.__dshAutotestClientApplied = true;
	  ctx.effect(() => () => {
	    globalThis.__dshAutotestClientApplied = void 0;
	  }, "dsh-autotest: apply claim");
	  ctx.effect(() => {
	    try {
	      ensureStyle();
	      const disposers = [];
	      disposers.push(mountSidebarEntry());
	      disposers.push(mountView());
	      return () => {
	        for (const dispose of disposers.splice(0)) dispose();
	      };
	    } catch (error) {
	      console.error("[dsh-autotest] client mount failed:", error);
	      return void 0;
	    }
	  }, "dsh-autotest: sidebar + view");
	}
	
		return module.exports;
	}
});
