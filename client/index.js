// dsh-antigravity-bridge client half — registers a card in Settings → Plugins →
// "Plugin configuration" that edits the `antigravity-bridge` settings namespace.
//
// Hand-written CJS bundle (no build chain; lives outside lib/ so tsdown's clean
// does not wipe it): the shell's `window.__ModuleLoader__` loads this file and
// hands it a `require` resolving only against the frozen seed table plus the
// graph edges declared in `package.json`'s `dsh.client.inject`.
window.__ModuleLoader__.load({
  id: "dsh-antigravity-bridge",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    const { Button, Input, Pill } = require("@deepseek-ai/dsh-client-ui-primitives");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");

    const NAMESPACE = "antigravity-bridge";
    const inject = ["slots", "locale", "settingsScope"];

    const LOCALE = {
      en: {
        agyTitle: "Antigravity Bridge",
        agyDescription: "Google Antigravity IDE bridge: sidebar visibility and approval notification behavior.",
        sidebarVisibleLabel: "Show cascades in IDE sidebar",
        sidebarVisibleHint: "agy ≥ 2.9.1 hides bridge-created sessions unless started with the JETBOX trajectory source. Disable to keep them external (search-only).",
        approvalGraceLabel: "YOLO approval grace (ms)",
        approvalGraceHint: "Wait this long for the IDE to auto-approve before pushing an approval notice. Default 3000.",
        save: "Save",
        discard: "Discard",
        unsaved: "Unsaved changes",
        saving: "Saving…",
        saveFailed: "Save failed",
        readOnly: "Read-only",
        collapse: "Hide settings",
        expand: "Show settings"
      },
      zh: {
        agyTitle: "Antigravity 桥接",
        agyDescription: "Google Antigravity IDE 桥接：侧边栏可见性与授权通知行为。",
        sidebarVisibleLabel: "在 IDE 侧边栏显示会话",
        sidebarVisibleHint: "agy ≥ 2.9.1 会隐藏桥接创建的会话，除非以 JETBOX 轨迹源启动。关闭则保持外部会话（仅可搜索）。",
        approvalGraceLabel: "YOLO 授权宽限（毫秒）",
        approvalGraceHint: "等待 IDE 自动通过授权的时长，超时未通过才推送授权通知。默认 3000。",
        save: "保存",
        discard: "丢弃",
        unsaved: "有未保存的修改",
        saving: "保存中…",
        saveFailed: "保存失败",
        readOnly: "只读",
        collapse: "收起设置",
        expand: "展开设置"
      }
    };

    const css = ".agycard{display:block;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:10px 14px;background:var(--dsw-alias-bg-base)}.agycard_header{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;cursor:pointer;padding:2px 0}.agycard_name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1}.agycard_desc{font-size:12px;color:var(--dsw-alias-label-tertiary)}.agycard_body{padding:8px 0 4px;display:flex;flex-direction:column;gap:12px}.agycard_row{display:flex;flex-direction:column;gap:4px;align-items:flex-start}.agycard_label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}.agycard_hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}.agycard_footer{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}";
    if (typeof document !== "undefined") {
      const tagId = "dsh-antigravity-bridge/card.css";
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-antigravity-bridge";
        tag.dataset.pluginCss = tagId;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    function AntigravityBridgeCard(props) {
      const React2 = React;
      const { t } = props;
      const state = props.useAgyBridgeCard((s) => s);
      const [open, setOpen] = React2.useState(false);

      if (state.status === "unavailable") return null;

      const writable = state.writable;
      const busy = state.saving;

      return jsxs("li", { className: "agycard", children: [
        jsx("button", {
          type: "button",
          className: "agycard_header",
          "aria-expanded": open,
          onClick: () => setOpen(!open),
          children: jsxs("span", { className: "agycard_name", children: [
            t("agyTitle"),
            jsx("span", { className: "agycard_desc", children: t("agyDescription") })
          ] })
        }),
        open ? jsxs("div", { className: "agycard_body", children: [
          !writable ? jsx("p", { className: "agycard_hint", children: t("readOnly") }) : null,
          jsx("div", { className: "agycard_row", children: [
            jsx("label", { className: "agycard_label", children: t("sidebarVisibleLabel") }),
            jsx(Pill, {
              active: state.sidebarVisible !== false,
              disabled: !writable,
              onClick: () => props.setSidebarVisible(state.sidebarVisible === false)
            }),
            jsx("p", { className: "agycard_hint", children: t("sidebarVisibleHint") })
          ] }),
          jsx("div", { className: "agycard_row", children: [
            jsx("label", { className: "agycard_label", children: t("approvalGraceLabel") }),
            jsx(Input, {
              value: String(state.approvalGraceMs ?? ""),
              disabled: !writable,
              placeholder: "3000",
              onChange: (event) => props.editGrace(event.target.value)
            }),
            jsx("p", { className: "agycard_hint", children: t("approvalGraceHint") })
          ] }),
          jsx("div", { className: "agycard_footer", children: [
            jsx(Button, {
              variant: "ghost",
              size: "sm",
              disabled: !state.dirty || busy,
              onClick: props.discard,
              children: t("discard")
            }),
            jsx(Button, {
              variant: "primary",
              size: "sm",
              disabled: !state.dirty || busy,
              onClick: props.save,
              children: t(state.saving ? "saving" : "save")
            })
          ] })
        ] }) : null
      ] });
    }

    // Staged-form controller over the settings scope (same pattern as the
    // fetch-proxy card): snapshot store over scope.getSnapshot, local staged
    // edits flushed on save and reset on discard.
    class AgyBridgeController {
      constructor(scope) {
        this.scope = scope;
        this.staged = null;
        this.store = createSnapshotStore(this.projection());
        scope.subscribe(() => {
          this.staged = null;
          this.publish();
        });
      }
      projection() {
        const snap = this.scope.getSnapshot();
        const value = snap.value ?? {};
        const staged = this.staged ?? {};
        return {
          status: snap.status,
          writable: snap.writable,
          sidebarVisible: staged.sidebarVisible !== undefined ? staged.sidebarVisible : value.sidebarVisible ?? snap.base?.sidebarVisible !== false,
          approvalGraceMs: staged.approvalGraceMs !== undefined ? staged.approvalGraceMs : value.approvalGraceMs ?? snap.base?.approvalGraceMs ?? 3000,
          dirty: this.staged !== null,
          saving: false
        };
      }
      getSnapshot() {
        return this.store.getSnapshot();
      }
      subscribe(listener) {
        return this.store.subscribe(listener);
      }
      publish() {
        this.store.set(this.projection());
      }
      setSidebarVisible(next) {
        this.staged = { ...(this.staged ?? this.stageBase()), sidebarVisible: next };
        this.publish();
      }
      editGrace(text) {
        this.staged = { ...(this.staged ?? this.stageBase()), approvalGraceMs: text };
        this.publish();
      }
      discard() {
        this.staged = null;
        this.publish();
      }
      async save() {
        if (this.staged === null) return;
        const staged = this.staged;
        const tasks = [];
        if (staged.sidebarVisible !== undefined) tasks.push(this.scope.set("sidebarVisible", staged.sidebarVisible === true));
        if (staged.approvalGraceMs !== undefined) {
          const n = Number.parseInt(String(staged.approvalGraceMs), 10);
          if (Number.isFinite(n) && n >= 0) tasks.push(this.scope.set("approvalGraceMs", n));
        }
        await Promise.all(tasks);
        this.staged = null;
        this.publish();
      }
      stageBase() {
        const snap = this.scope.getSnapshot();
        const value = snap.value ?? {};
        return {
          sidebarVisible: value.sidebarVisible ?? snap.base?.sidebarVisible !== false,
          approvalGraceMs: value.approvalGraceMs ?? snap.base?.approvalGraceMs ?? 3000
        };
      }
      inject() {
        return {
          hooks: { agyBridgeCard: this },
          save: () => this.save(),
          discard: () => this.discard(),
          setSidebarVisible: (next) => this.setSidebarVisible(next),
          editGrace: (text) => this.editGrace(text)
        };
      }
    }

    function apply(ctx) {
      ctx.locale.register("antigravity-bridge", { en: LOCALE.en, zh: LOCALE.zh });

      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      const controller = new AgyBridgeController(scope);

      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: "antigravity-bridge",
        locale: "antigravity-bridge",
        inject: () => controller.inject()
      }, AntigravityBridgeCard));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
