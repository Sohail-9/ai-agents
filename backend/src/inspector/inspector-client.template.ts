// Inspector-client iframe script source. Edit the JS body inside the template literal
// below. The string is read at workspace boot, placeholders replaced with the parent
// origin + version, and the result written into /workspace/frontend/public/.pf/inspector-client.js.

export const INSPECTOR_CLIENT_TEMPLATE = String.raw`
/**
 * Prettiflow inspector client. Runs inside the user's E2B sandbox iframe.
 *
 * The host writes this file with two placeholders replaced at write time:
 *   __PF_PARENT_ORIGIN__   — the parent app origin (exact-equality check)
 *   __PF_INSPECTOR_VERSION__ — protocol version
 *
 * No external deps. Pure browser JS. Self-contained.
 */
(function () {
  if (window.__pfInspectorMounted) return;
  window.__pfInspectorMounted = true;

  var PARENT_ORIGIN = "__PF_PARENT_ORIGIN__";
  var INSPECTOR_VERSION = "__PF_INSPECTOR_VERSION__"; // v15: inline dblclick text editing

  var TYPOGRAPHY_PROPS = [
    "fontFamily","fontSize","fontWeight","fontStyle","lineHeight","letterSpacing","textAlign","textTransform","textDecorationLine",
    "color","backgroundColor",
    "borderColor","borderStyle","borderWidth","borderRadius",
    "opacity","boxShadow",
    "marginTop","marginRight","marginBottom","marginLeft",
    "paddingTop","paddingRight","paddingBottom","paddingLeft"
  ];

  var mode = "idle";
  var currentSelected = null; // Element
  var currentSelector = null;
  var overrides = Object.create(null); // { selector: { prop: value } }
  var editingEl = null;
  var editingOrigText = "";

  // -------- shadow-DOM overlay (outline + tag label) --------
  var host = document.createElement("div");
  host.setAttribute("data-pf-inspector-overlay", "");
  host.style.cssText =
    "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
  document.documentElement.appendChild(host);
  var shadow = host.attachShadow({ mode: "closed" });
  var styleEl = document.createElement("style");
  styleEl.textContent =
    ".outline{position:fixed;border-style:solid;pointer-events:none;box-sizing:border-box;}\n" +
    ".outline.selected{border-color:#22d3ee;border-width:2px;}\n" +
    ".outline.hover{border-color:#22d3ee;border-width:1px;border-style:dashed;opacity:0.7;}\n" +
    ".label{position:fixed;background:#0a0a0a;color:#22d3ee;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;line-height:1;padding:3px 6px;border-radius:3px;border:1px solid rgba(34,211,238,0.35);pointer-events:none;white-space:nowrap;}";
  shadow.appendChild(styleEl);
  var hoverOutline = document.createElement("div");
  hoverOutline.className = "outline hover";
  hoverOutline.style.display = "none";
  shadow.appendChild(hoverOutline);
  var selectedOutline = document.createElement("div");
  selectedOutline.className = "outline selected";
  selectedOutline.style.display = "none";
  shadow.appendChild(selectedOutline);
  var tagLabel = document.createElement("div");
  tagLabel.className = "label";
  tagLabel.style.display = "none";
  shadow.appendChild(tagLabel);

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  function placeOutline(el, node) {
    var r = el.getBoundingClientRect();
    node.style.display = "block";
    node.style.top = r.top + "px";
    node.style.left = r.left + "px";
    node.style.width = r.width + "px";
    node.style.height = r.height + "px";
  }

  function hideHover() {
    hoverOutline.style.display = "none";
  }

  function placeTagLabel(el) {
    if (!el) {
      tagLabel.style.display = "none";
      return;
    }
    var r = el.getBoundingClientRect();
    var label = el.tagName.toLowerCase();
    if (el.classList && el.classList[0]) {
      var cls = el.classList[0];
      if (cls.length > 24) cls = cls.slice(0, 24) + "…";
      label += "." + cls;
    }
    tagLabel.textContent = label;
    tagLabel.style.display = "block";
    var top = r.top - 22;
    if (top < 0) top = r.top + 4;
    tagLabel.style.top = top + "px";
    tagLabel.style.left = Math.max(0, r.left) + "px";
  }

  // -------- selector helpers --------
  function cssEscape(v) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(v);
    return String(v).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return "\\" + ch; });
  }

  function buildSelector(el) {
    if (!el || el === document.documentElement) return "html";
    if (el === document.body) return "body";
    if (el.id) {
      var idSel = "#" + cssEscape(el.id);
      try {
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      } catch (e) {}
    }
    var parts = [];
    var cur = el;
    while (cur && cur !== document.documentElement && cur.tagName !== "BODY") {
      var parent = cur.parentElement;
      if (!parent) break;
      var nth = 1;
      var sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) nth += 1;
        sib = sib.previousElementSibling;
      }
      parts.unshift(cur.tagName.toLowerCase() + ":nth-of-type(" + nth + ")");
      cur = parent;
    }
    return parts.length > 0 ? "body > " + parts.join(" > ") : null;
  }

  function classShorthand(el) {
    var c = el.classList && el.classList[0];
    if (!c) return "";
    return "." + (c.length > 24 ? c.slice(0, 24) + "…" : c);
  }

  function buildBreadcrumb(el) {
    var chain = [];
    var cur = el;
    while (cur && cur !== document.body && cur.tagName !== "HTML" && cur.tagName !== "BODY") {
      chain.unshift(cur);
      cur = cur.parentElement;
    }
    return chain.map(function (node) {
      var sel = buildSelector(node) || node.tagName.toLowerCase();
      return {
        tagName: node.tagName.toLowerCase(),
        classShorthand: classShorthand(node),
        selector: sel,
        classes: Array.from(node.classList || []),
      };
    });
  }

  function readTypography(el) {
    var s = window.getComputedStyle(el);
    var out = {};
    for (var i = 0; i < TYPOGRAPHY_PROPS.length; i += 1) {
      var k = TYPOGRAPHY_PROPS[i];
      var v = s[k];
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  }

  // -------- apply / reset --------
  function applyStyleTo(el, style) {
    if (!el || !style) return;
    for (var k in style) {
      if (!Object.prototype.hasOwnProperty.call(style, k)) continue;
      if (TYPOGRAPHY_PROPS.indexOf(k) === -1) continue;
      var v = style[k];
      try {
        if (v === "") el.style[k] = "";
        else el.style[k] = v;
      } catch (e) {}
    }
  }

  function clearOverridesOn(el) {
    if (!el) return;
    for (var i = 0; i < TYPOGRAPHY_PROPS.length; i += 1) {
      try { el.style[TYPOGRAPHY_PROPS[i]] = ""; } catch (e) {}
    }
  }

  // -------- post helpers --------
  function postToParent(msg) {
    try {
      window.parent.postMessage(msg, PARENT_ORIGIN);
    } catch (e) {}
  }

  // Text-bearing tags whose visible text is reasonable to edit in place.
  var EDITABLE_TAGS = {
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    P: 1, BUTTON: 1, A: 1, LI: 1,
    SPAN: 1, STRONG: 1, EM: 1, B: 1, I: 1, U: 1, S: 1, SMALL: 1, MARK: 1, SUB: 1, SUP: 1,
    LABEL: 1, FIGCAPTION: 1, BLOCKQUOTE: 1, Q: 1, CITE: 1,
    SUMMARY: 1, DT: 1, DD: 1, CAPTION: 1, TD: 1, TH: 1,
    CODE: 1, KBD: 1, PRE: 1, SAMP: 1,
  };

  function hasEditableText(el) {
    if (!el || !el.tagName) return false;
    if (!EDITABLE_TAGS[el.tagName]) return false;
    var t = (el.textContent || "").trim();
    return t.length > 0 && t.length <= 2000;
  }

  function collectTextNodes(el) {
    var nodes = [];
    if (!el) return nodes;
    if (typeof document.createTreeWalker !== "function") return nodes;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // Update an element's visible text by writing into the first non-whitespace
  // text node and clearing the rest. Preserves nested elements (icons, gradient
  // spans, line breaks) so structure isn't lost when the user edits text.
  function setVisibleText(el, newText) {
    var nodes = collectTextNodes(el);
    if (nodes.length === 0) {
      el.textContent = newText;
      return;
    }
    var primaryIdx = -1;
    for (var i = 0; i < nodes.length; i += 1) {
      if ((nodes[i].nodeValue || "").trim().length > 0) {
        primaryIdx = i;
        break;
      }
    }
    if (primaryIdx === -1) primaryIdx = 0;
    for (var j = 0; j < nodes.length; j += 1) {
      nodes[j].nodeValue = j === primaryIdx ? newText : "";
    }
  }

  // -------- inline text editing --------
  function exitInlineEdit(commit) {
    if (!editingEl) return;
    var el = editingEl;
    editingEl = null;
    el.contentEditable = "false";
    el.style.cursor = "";
    if (commit) {
      var newText = el.textContent || "";
      if (newText !== editingOrigText) {
        postToParent({ kind: "pf:text-edited", selector: currentSelector, text: newText });
      }
    } else {
      el.textContent = editingOrigText;
    }
    if (currentSelected) placeOutline(currentSelected, selectedOutline);
  }

  function startInlineEdit(el) {
    if (editingEl) exitInlineEdit(true);
    editingOrigText = el.textContent || "";
    editingEl = el;
    el.contentEditable = "true";
    el.style.cursor = "text";
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }

  function emitElementSelected(el) {
    if (editingEl && editingEl !== el) exitInlineEdit(true);
    var sel = buildSelector(el);
    if (!sel) return;
    currentSelected = el;
    currentSelector = sel;
    placeOutline(el, selectedOutline);
    placeTagLabel(el);
    hideHover();
    var editable = hasEditableText(el);
    postToParent({
      kind: "pf:element-selected",
      selector: sel,
      tagName: el.tagName.toLowerCase(),
      computedStyle: readTypography(el),
      rect: rectOf(el),
      breadcrumb: buildBreadcrumb(el),
      hasEditableText: editable,
      currentText: editable ? (el.textContent || "") : "",
      classes: Array.from(el.classList || []),
      src: el.tagName === "IMG" ? el.getAttribute("src") || "" : "",
    });
  }

  // -------- listeners (always installed, only act when mode === inspect) --------
  var hoverRafPending = false;
  var lastHoverEl = null;
  function onMouseOver(e) {
    if (mode !== "inspect") return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (host.contains(t)) return;
    if (t === currentSelected) {
      hideHover();
      lastHoverEl = null;
      return;
    }
    lastHoverEl = t;
    if (hoverRafPending) return;
    hoverRafPending = true;
    requestAnimationFrame(function () {
      hoverRafPending = false;
      if (lastHoverEl) {
        placeOutline(lastHoverEl, hoverOutline);
        postToParent({ kind: "pf:element-hovered", rect: rectOf(lastHoverEl) });
      }
    });
  }

  function onMouseOut() {
    if (mode !== "inspect") return;
    hideHover();
    postToParent({ kind: "pf:element-hovered", rect: null });
  }

  function onClick(e) {
    if (mode !== "inspect") return;
    if (editingEl) return; // let clicks through during inline edit
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (host.contains(t)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    emitElementSelected(t);
  }

  function onDblClick(e) {
    if (mode !== "inspect") return;
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (host.contains(t)) return;
    if (!hasEditableText(t)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (t !== currentSelected) emitElementSelected(t);
    startInlineEdit(t);
  }

  function onEditKeyDown(e) {
    if (!editingEl) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); editingEl.blur(); }
    if (e.key === "Escape") { e.preventDefault(); exitInlineEdit(false); }
  }

  function onFocusOut(e) {
    if (editingEl && e.target === editingEl) exitInlineEdit(true);
  }

  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("dblclick", onDblClick, true);
  document.addEventListener("keydown", onEditKeyDown, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("submit", function (e) { if (mode === "inspect") { e.preventDefault(); e.stopPropagation(); } }, true);

  // Reposition outlines on scroll/resize
  function reposition() {
    if (currentSelected && document.body.contains(currentSelected)) {
      placeOutline(currentSelected, selectedOutline);
      placeTagLabel(currentSelected);
    } else {
      selectedOutline.style.display = "none";
      tagLabel.style.display = "none";
    }
  }
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  // -------- inbound message handler --------
  window.addEventListener("message", function (e) {
    if (e.origin !== PARENT_ORIGIN) return;
    var msg = e.data;
    if (!msg || typeof msg !== "object" || typeof msg.kind !== "string") return;
    switch (msg.kind) {
      case "pf:set-mode":
        mode = msg.mode === "inspect" ? "inspect" : "idle";
        if (mode === "idle") {
          exitInlineEdit(true);
          hideHover();
          selectedOutline.style.display = "none";
          tagLabel.style.display = "none";
          currentSelected = null;
          currentSelector = null;
        }
        break;
      case "pf:apply-style": {
        if (typeof msg.selector !== "string" || !msg.style) return;
        var el = document.querySelector(msg.selector);
        if (!el) {
          postToParent({ kind: "pf:element-not-found", selector: msg.selector });
          return;
        }
        clearOverridesOn(el);
        overrides[msg.selector] = msg.style;
        applyStyleTo(el, msg.style);
        if (el === currentSelected) reposition();
        break;
      }
      case "pf:reset": {
        if (typeof msg.selector !== "string") return;
        var rEl = document.querySelector(msg.selector);
        if (rEl) clearOverridesOn(rEl);
        delete overrides[msg.selector];
        if (rEl === currentSelected) reposition();
        break;
      }
      case "pf:re-select": {
        if (typeof msg.selector !== "string") return;
        var rsEl = document.querySelector(msg.selector);
        if (!rsEl) {
          postToParent({ kind: "pf:element-not-found", selector: msg.selector });
          return;
        }
        emitElementSelected(rsEl);
        break;
      }
      case "pf:climb-to-ancestor": {
        if (typeof msg.selector !== "string" || typeof msg.depth !== "number") return;
        var target = document.querySelector(msg.selector);
        if (!target) {
          postToParent({ kind: "pf:element-not-found", selector: msg.selector });
          return;
        }
        var cur = target;
        for (var i = 0; i < msg.depth; i += 1) {
          if (!cur || !cur.parentElement) return;
          cur = cur.parentElement;
          if (cur === document.body || cur === document.documentElement) return;
        }
        if (cur && cur !== target) emitElementSelected(cur);
        break;
      }
      case "pf:set-content": {
        if (typeof msg.selector !== "string" || typeof msg.text !== "string") return;
        var cEl = document.querySelector(msg.selector);
        if (!cEl) {
          postToParent({ kind: "pf:element-not-found", selector: msg.selector });
          return;
        }
        if (!hasEditableText(cEl)) return;
        setVisibleText(cEl, msg.text);
        if (cEl === currentSelected) reposition();
        break;
      }
      case "pf:apply-attribute": {
        if (typeof msg.selector !== "string" || typeof msg.attribute !== "string" || typeof msg.value !== "string") return;
        var aEl = document.querySelector(msg.selector);
        if (!aEl) {
          postToParent({ kind: "pf:element-not-found", selector: msg.selector });
          return;
        }
        try { aEl.setAttribute(msg.attribute, msg.value); } catch (e) {}
        if (aEl === currentSelected) reposition();
        break;
      }
    }
  });

  // -------- handshake --------
  postToParent({ kind: "pf:ready", inspectorVersion: INSPECTOR_VERSION });
})();
`;
