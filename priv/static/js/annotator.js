// Canvas overlay for screenshot annotations.
// Tools: cursor (no-op), rect, arrow, text, crop. Undo pops the last annotation.
//
// Crop is a non-destructive, two-stage viewport:
//  - In crop tool: canvas is full image size, `this.cropDraft` is an editable
//    rectangle with adjustable handles (drag to resize/move; click empty area
//    to draw a new draft). Re-entering the crop tool transfers the committed
//    crop back to `cropDraft` so the user can adjust it.
//  - On `commitCropDraft()` (driven by the widget's Anwenden button or by
//    Fertig): the draft becomes `this.crop`, the canvas shrinks to the crop
//    dimensions (image is offset via ctx.translate), and the tool switches
//    back to cursor.
//
// Annotations are always stored in original-image coords. When `this.crop` is
// set, draws are translated so the crop top-left aligns with canvas (0,0).
//
// All size constants below are in *CSS pixels*. The constructor multiplies them
// by `opts.scale` (the captured-pixel-to-CSS-pixel ratio, typically the display
// DPR) so a Retina (2×) and non-Retina (1×) capture render annotations at the
// same visible weight relative to the captured page content.

const STROKE = "#E5484D"; // hi-error red
const STROKE_WIDTH = 10;
const ARROW_HEAD = 48;
const ARROW_HEAD_ANGLE = Math.PI / 6;
const TEXT_FONT_SIZE = 40;
const TEXT_FONT_FAMILY = "'IBM Plex Sans', -apple-system, sans-serif";
const TEXT_FONT_WEIGHT = 700;
const TEXT_LINE_HEIGHT = 1.15;
const TEXT_PAD_X = 14;
const TEXT_PAD_Y = 6;
const TEXT_RADIUS = 6;
const TEXT_FG = "#ffffff";
const DRAG_MIN_PX = 4;
// Sketchy multi-pass strokes (Excalidraw-style): each edge is drawn 2–3 times
// with a different bezier control point and slight endpoint nudges per pass.
const SKETCH_PASSES_SHAFT = 3;
const SKETCH_PASSES_HEAD = 2;
const SKETCH_PASSES_TEXT_EDGE = 2;
const SKETCH_LINE_WIDTH_RATIO = 0.45;
const SKETCH_BOW_MAX = 6;
const SKETCH_ENDPOINT_JITTER = 3;
const SKETCH_T_JITTER = 0.15;
const TEXT_FILL_BOW_MAX = 4;
// Selection chrome (cursor tool): filled-circle handles drawn on top of the
// selected annotation. Sizes are in CSS px and × scale. The handles alone
// are enough to communicate selection — no bounding box needed.
const HANDLE_RADIUS = 7;
const HANDLE_HIT_RADIUS = 12;
const HANDLE_FILL = "#ffffff";
const HANDLE_STROKE = "#E5484D";

function distToSegment(p, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - ax, p.y - ay);
  let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Annotator {
  constructor(canvas, screenshotImage, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.image = screenshotImage;
    this.tool = "rect";
    this.color = opts.color || STROKE;
    // `scale` ties annotation pixel sizes to the underlying capture so a
    // Retina (2×) and non-Retina (1×) screenshot get the same visible weight.
    this.scale = opts.scale > 0 ? opts.scale : 1;
    this.strokeWidth = (opts.strokeWidth || STROKE_WIDTH) * this.scale;
    this.onSelectionChange = opts.onSelectionChange || null;
    this.onToolChange = opts.onToolChange || null;
    this.onCropDraftChange = opts.onCropDraftChange || null;
    // Hydrate from saved state when re-entering the annotator on a previously
    // attached screenshot. Always deep-clone so external state isn't mutated
    // by subsequent edits.
    this.annotations = Array.isArray(opts.initialAnnotations)
      ? opts.initialAnnotations.map((a) => ({ ...a }))
      : [];
    // Undo history. Each entry is a deep snapshot of the annotator state taken
    // before a mutating action (drawing, dragging, deleting, applying a crop).
    // Bounded so a long session can't bloat memory.
    this._history = [];
    this._historyMax = 100;
    // Committed crop, in image coords. `null` means the canvas shows the
    // full image. When set, the canvas is sized to crop dims and draws are
    // translated by (-crop.x, -crop.y).
    this.crop = opts.initialCrop ? { ...opts.initialCrop } : null;
    // Pending crop while in the crop tool. Mutually exclusive with `this.crop`.
    this.cropDraft = null;
    this.drawing = null;
    this.selectedIndex = null;
    this.dragState = null;
    this._editingIndex = null;
    this._bindings = [];
    // Size the canvas to match the current view: cropped if a committed crop
    // was hydrated, otherwise the full image.
    if (screenshotImage && screenshotImage.width && screenshotImage.height) {
      if (this.crop) {
        canvas.width = this.crop.w;
        canvas.height = this.crop.h;
      } else {
        canvas.width = screenshotImage.width;
        canvas.height = screenshotImage.height;
      }
    }
    this._bind();
    this.redraw();
  }

  // Returns a deep clone of the current annotation list — callers can safely
  // hold this across annotator sessions without aliasing internal state.
  getAnnotations() {
    return this.annotations.map((a) => ({ ...a }));
  }

  // Original (uncropped) screenshot bitmap. Crop is stored separately and
  // applied only at render time, so the underlying image never changes.
  getImage() {
    return this.image;
  }

  getCrop() {
    return this.crop ? { ...this.crop } : null;
  }

  setTool(name) {
    const prev = this.tool;
    // Leaving crop mode with an unconfirmed draft auto-commits it — losing
    // the draft on a tool switch would feel punishing. The Anwenden button
    // is the explicit path; this is the implicit one.
    if (prev === "crop" && name !== "crop" && this.cropDraft) {
      this._commitCropDraft();
      // _commitCropDraft already set this.tool = "cursor"; honour the requested
      // tool unless commit landed us on cursor and the caller asked for cursor.
      if (name !== "cursor") {
        this.tool = name;
      }
    } else {
      this.tool = name;
    }

    if (this.tool === "crop") {
      // Entering crop mode: expand canvas to full image and lift the committed
      // crop into a draft so the user can adjust the same region.
      this._enterCropMode();
    }

    if (this.tool !== "cursor") {
      // Drop any selection chrome when switching to a draw tool.
      this._setSelection(null);
      this.dragState = null;
    }
    this.canvas.style.cursor =
      this.tool === "cursor" ? "default" : this.tool === "text" ? "text" : "crosshair";
    this.redraw();
  }

  _enterCropMode() {
    if (this.crop) {
      this.cropDraft = { ...this.crop };
      this.crop = null;
    }
    // Always size the canvas to the full image while editing the crop draft.
    if (this.image) {
      this.canvas.width = this.image.width || this.canvas.width;
      this.canvas.height = this.image.height || this.canvas.height;
    }
    if (this.onCropDraftChange) this.onCropDraftChange(!!this.cropDraft);
  }

  // Public: invoked by the widget's "Anwenden" button. Commits the current
  // draft as `this.crop`, shrinks the canvas, and switches to the cursor tool.
  // Returns true if a commit happened, false if there was no valid draft.
  commitCropDraft() {
    return this._commitCropDraft();
  }

  _commitCropDraft() {
    if (!this.cropDraft) return false;
    const x = Math.min(this.cropDraft.x, this.cropDraft.x + this.cropDraft.w);
    const y = Math.min(this.cropDraft.y, this.cropDraft.y + this.cropDraft.h);
    const w = Math.abs(this.cropDraft.w);
    const h = Math.abs(this.cropDraft.h);
    const ix = Math.max(0, x);
    const iy = Math.max(0, y);
    const iw = Math.min(this.image.width - ix, w);
    const ih = Math.min(this.image.height - iy, h);
    if (iw < 1 || ih < 1) {
      this.cropDraft = null;
      if (this.onCropDraftChange) this.onCropDraftChange(false);
      this.redraw();
      return false;
    }
    // Snapshot before applying so undo lands the user back in crop mode with
    // the draft restored — exactly the state they had right before pressing
    // Anwenden.
    this._pushHistory();
    this.crop = { x: ix, y: iy, w: iw, h: ih };
    this.cropDraft = null;
    this.canvas.width = iw;
    this.canvas.height = ih;
    this._setSelection(null);
    this.tool = "cursor";
    this.canvas.style.cursor = "default";
    if (this.onToolChange) this.onToolChange("cursor");
    if (this.onCropDraftChange) this.onCropDraftChange(false);
    this.redraw();
    return true;
  }

  undo() {
    const snap = this._history.pop();
    if (!snap) return;
    this.annotations = snap.annotations.map((a) => ({ ...a }));
    this.crop = snap.crop ? { ...snap.crop } : null;
    this.cropDraft = snap.cropDraft ? { ...snap.cropDraft } : null;
    this.canvas.width = snap.canvasW;
    this.canvas.height = snap.canvasH;
    const oldTool = this.tool;
    this.tool = snap.tool;
    this.dragState = null;
    this.drawing = null;
    this._editingIndex = null;
    if (this._textInput) {
      this._textInput.remove();
      this._textInput = null;
    }
    this.canvas.style.cursor =
      this.tool === "cursor" ? "default" : this.tool === "text" ? "text" : "crosshair";
    if (oldTool !== this.tool && this.onToolChange) this.onToolChange(this.tool);
    if (this.onCropDraftChange) this.onCropDraftChange(!!this.cropDraft);
    const newSelection = snap.selectedIndex != null && snap.selectedIndex < this.annotations.length
      ? snap.selectedIndex
      : null;
    if (this.selectedIndex !== newSelection) {
      this.selectedIndex = newSelection;
      if (this.onSelectionChange) this.onSelectionChange(newSelection != null);
    }
    this.redraw();
  }

  _snapshot() {
    return {
      annotations: this.annotations.map((a) => ({ ...a })),
      crop: this.crop ? { ...this.crop } : null,
      cropDraft: this.cropDraft ? { ...this.cropDraft } : null,
      canvasW: this.canvas.width,
      canvasH: this.canvas.height,
      tool: this.tool,
      selectedIndex: this.selectedIndex,
    };
  }

  _pushHistory() {
    this._history.push(this._snapshot());
    if (this._history.length > this._historyMax) this._history.shift();
  }

  deleteSelected() {
    if (this.selectedIndex == null) return;
    this._pushHistory();
    this.annotations.splice(this.selectedIndex, 1);
    this._setSelection(null);
    this.redraw();
  }

  _setSelection(index) {
    if (this.selectedIndex === index) return;
    this.selectedIndex = index;
    if (this.onSelectionChange) this.onSelectionChange(index != null);
  }

  // Called after a draw tool successfully commits a new annotation. Switches
  // back to the cursor tool and selects the new shape so the user can move,
  // reshape, or delete it without re-clicking the toolbar.
  _finishDraw(index) {
    this.tool = "cursor";
    this.canvas.style.cursor = "default";
    this._setSelection(index);
    if (this.onToolChange) this.onToolChange("cursor");
    this.redraw();
  }

  destroy() {
    this._bindings.forEach(([target, ev, fn]) => target.removeEventListener(ev, fn));
    this._bindings = [];
    if (this._textInput) {
      this._textInput.remove();
      this._textInput = null;
    }
  }

  toBlob() {
    const out = this.renderToCanvas();
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
  }

  _bind() {
    const add = (target, ev, fn) => {
      target.addEventListener(ev, fn);
      this._bindings.push([target, ev, fn]);
    };

    add(this.canvas, "mousedown", (e) => this._onDown(e));
    add(this.canvas, "dblclick", (e) => this._onDblClick(e));
    add(window, "mousemove", (e) => this._onMove(e));
    add(window, "mouseup", (e) => this._onUp(e));
    add(window, "keydown", (e) => this._onKey(e));
  }

  _onDblClick(e) {
    if (this.tool !== "cursor") return;
    const p = this._pos(e);
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      const a = this.annotations[i];
      if (a.type === "text" && this._hitBody(a, p)) {
        e.preventDefault();
        this._editTextAt(i);
        return;
      }
    }
  }

  _editTextAt(index) {
    const a = this.annotations[index];
    if (!a || a.type !== "text") return;
    const rect = this.canvas.getBoundingClientRect();
    const displayScale = rect.width > 0 ? rect.width / this.canvas.width : 1;
    // Position the editor at the annotation's top-left in client coords so
    // it sits exactly on top of the existing rendered box.
    const editorClientX = rect.left + a.x * displayScale;
    const editorClientY = rect.top + a.y * displayScale;
    this._editingIndex = index;
    this.redraw();
    this._openTextEditor({ x: a.x, y: a.y }, editorClientX, editorClientY, {
      initialText: a.text,
      replaceIndex: index,
    });
  }

  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / rect.width;
    const sy = this.canvas.height / rect.height;
    let x = (e.clientX - rect.left) * sx;
    let y = (e.clientY - rect.top) * sy;
    // The canvas is offset when a committed crop is active, but annotations
    // and hit-tests live in original-image coords. Translate so callers always
    // see image coords regardless of crop state.
    if (this.crop) {
      x += this.crop.x;
      y += this.crop.y;
    }
    return { x, y };
  }

  _onDown(e) {
    const p = this._pos(e);

    if (this._textInput) {
      // Click outside the open editor — commit via blur and stop. The user
      // was dismissing the editor, not starting a new selection.
      this._textInput.blur();
      return;
    }

    if (this.tool === "cursor") {
      e.preventDefault();
      const hit = this._hitTest(p);
      if (hit) {
        // Snapshot before any drag so undo restores the pre-drag geometry.
        // A click without movement leaves an unused snapshot — undo will then
        // be a no-op visually, which is acceptable.
        this._pushHistory();
        this._setSelection(hit.index);
        const a = this.annotations[hit.index];
        this.dragState = {
          target: hit.target,
          startPoint: p,
          original: { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 },
          targetRef: "annotation",
        };
        this.canvas.style.cursor = hit.cursor || "default";
      } else {
        this._setSelection(null);
      }
      this.redraw();
      return;
    }

    if (this.tool === "crop") {
      e.preventDefault();
      // Adjust an existing draft via its handles or body before drawing a new
      // one — clicks on empty space still start a fresh marquee.
      if (this.cropDraft) {
        const hit = this._hitDraft(p);
        if (hit) {
          this._pushHistory();
          this.dragState = {
            target: hit.target,
            startPoint: p,
            original: { ...this.cropDraft },
            targetRef: "cropDraft",
          };
          this.canvas.style.cursor = hit.cursor;
          return;
        }
      }
      // Drawing a brand-new marquee replaces the existing draft; snapshot so
      // undo restores the previous draft (or the no-draft state).
      this._pushHistory();
      this.drawing = { type: "crop", x: p.x, y: p.y, w: 0, h: 0 };
      this.cropDraft = null;
      if (this.onCropDraftChange) this.onCropDraftChange(false);
      return;
    }

    e.preventDefault();
    if (this.tool === "text") {
      this._openTextEditor(p, e.clientX, e.clientY);
      return;
    }

    // Snapshot before drawing rect/arrow so undo removes the new shape on
    // commit. Push at mousedown so we capture the pre-drawing state cleanly;
    // a click that doesn't pass the DRAG_MIN_PX threshold leaves an unused
    // snapshot, which is harmless.
    this._pushHistory();
    this.drawing = { type: this.tool, x: p.x, y: p.y, w: 0, h: 0 };
  }

  _hitDraft(p) {
    if (!this.cropDraft) return null;
    const r = HANDLE_HIT_RADIUS * this.scale;
    const handles = this._handlesFor({ type: "rect", ...this.cropDraft });
    for (const h of handles) {
      if (Math.hypot(p.x - h.x, p.y - h.y) <= r) {
        return { target: "handle:" + h.name, cursor: h.cursor };
      }
    }
    const x1 = Math.min(this.cropDraft.x, this.cropDraft.x + this.cropDraft.w);
    const y1 = Math.min(this.cropDraft.y, this.cropDraft.y + this.cropDraft.h);
    const x2 = Math.max(this.cropDraft.x, this.cropDraft.x + this.cropDraft.w);
    const y2 = Math.max(this.cropDraft.y, this.cropDraft.y + this.cropDraft.h);
    if (p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2) {
      return { target: "body", cursor: "move" };
    }
    return null;
  }

  _openTextEditor(canvasPos, clientX, clientY, opts = {}) {
    const rect = this.canvas.getBoundingClientRect();
    const displayScale = rect.width > 0 ? rect.width / this.canvas.width : 1;
    const cssScale = this.scale * displayScale;

    const input = document.createElement("textarea");
    input.rows = 1;
    input.className = "fb-text-input";
    input.style.left = clientX + "px";
    input.style.top = clientY + "px";
    input.style.fontSize = TEXT_FONT_SIZE * cssScale + "px";
    input.style.padding = `${TEXT_PAD_Y * cssScale}px ${TEXT_PAD_X * cssScale}px`;
    input.style.borderRadius = TEXT_RADIUS * cssScale + "px";
    input.style.background = this.color;
    if (opts.initialText) input.value = opts.initialText;

    document.body.appendChild(input);
    this._textInput = input;
    setTimeout(() => {
      input.focus();
      // Place the caret at the end so the user can keep typing immediately.
      const len = input.value.length;
      try { input.setSelectionRange(len, len); } catch (_e) {}
    }, 0);

    const finishInPlace = () => {
      this._editingIndex = null;
    };

    const commit = () => {
      if (this._textInput !== input) return;
      const text = input.value.replace(/\s+$/, "");
      input.remove();
      this._textInput = null;

      if (opts.replaceIndex != null) {
        const i = opts.replaceIndex;
        // Snapshot when the text actually changes (or is being deleted).
        if (text !== this.annotations[i].text) this._pushHistory();
        if (text) {
          this.annotations[i].text = text;
          finishInPlace();
          this._setSelection(i);
          this.redraw();
        } else {
          this.annotations.splice(i, 1);
          finishInPlace();
          this._setSelection(null);
          this.redraw();
        }
        return;
      }

      if (text) {
        this._pushHistory();
        this.annotations.push({ type: "text", x: canvasPos.x, y: canvasPos.y, text });
        this._finishDraw(this.annotations.length - 1);
      } else {
        // Empty commit (e.g. user clicked outside without typing) — still
        // exit text-entry mode so they aren't stranded with the text tool.
        this._finishDraw(null);
      }
    };

    const cancel = () => {
      if (this._textInput !== input) return;
      input.remove();
      this._textInput = null;
      if (opts.replaceIndex != null) {
        finishInPlace();
        this._setSelection(opts.replaceIndex);
        this.redraw();
      }
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    input.addEventListener("blur", commit);
  }

  _onMove(e) {
    const p = this._pos(e);

    if (this.dragState) {
      this._applyDrag(p);
      this.redraw();
      return;
    }
    if (this.drawing) {
      this.drawing.w = p.x - this.drawing.x;
      this.drawing.h = p.y - this.drawing.y;
      this.redraw();
      return;
    }
    if (this.tool === "cursor") {
      const hit = this._hitTest(p);
      this.canvas.style.cursor = hit ? hit.cursor || "default" : "default";
    }
  }

  _onUp() {
    if (this.dragState) {
      this.dragState = null;
      this.canvas.style.cursor =
        this.tool === "cursor" ? "default" : this.tool === "text" ? "text" : "crosshair";
      return;
    }
    if (!this.drawing) return;
    const min = DRAG_MIN_PX * this.scale;
    const committed =
      Math.abs(this.drawing.w) > min || Math.abs(this.drawing.h) > min;
    const drawn = this.drawing;
    this.drawing = null;
    if (!committed) {
      this.redraw();
      return;
    }
    if (drawn.type === "crop") {
      // Drawing a marquee creates the draft — handles are now adjustable.
      // Commit waits for the explicit Anwenden button (or Fertig auto-apply).
      this.cropDraft = { x: drawn.x, y: drawn.y, w: drawn.w, h: drawn.h };
      if (this.onCropDraftChange) this.onCropDraftChange(true);
      this.redraw();
      return;
    }
    this.annotations.push(drawn);
    this._finishDraw(this.annotations.length - 1);
  }

  // Renders a clean (no UI chrome, no dim overlay) version of the current
  // image + annotations into a freshly-allocated canvas, cropped to `this.crop`
  // if set. Used by toBlob() and the widget's thumbnail data URL.
  renderToCanvas() {
    const out = document.createElement("canvas");
    if (this.crop) {
      out.width = this.crop.w;
      out.height = this.crop.h;
    } else {
      out.width = this.canvas.width;
      out.height = this.canvas.height;
    }

    // Temporarily redirect drawing through the offscreen canvas. `redraw()`
    // and the per-shape draw helpers all read `this.ctx` / `this.canvas`,
    // so swapping them is enough to retarget without duplicating code.
    const realCtx = this.ctx;
    const realCanvas = this.canvas;
    const savedTool = this.tool;
    const savedCrop = this.crop;
    const savedDrawing = this.drawing;

    this.ctx = out.getContext("2d");
    this.canvas = out;
    if (savedCrop) this.ctx.translate(-savedCrop.x, -savedCrop.y);
    // Suppress UI chrome: cursor selection and crop-dim shouldn't bleed into
    // the exported image. `drawing` is also nulled so any in-flight marquee
    // doesn't get baked in (shouldn't happen during export, defensive).
    this.tool = "";
    this.crop = null;
    this.drawing = null;

    this.redraw();

    this.ctx = realCtx;
    this.canvas = realCanvas;
    this.tool = savedTool;
    this.crop = savedCrop;
    this.drawing = savedDrawing;

    return out;
  }

  _onKey(e) {
    if (this.selectedIndex == null) return;
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Delete" || e.key === "Backspace") {
      this.deleteSelected();
      e.preventDefault();
    } else if (e.key === "Escape") {
      this._setSelection(null);
      this.redraw();
    }
  }

  _hitTest(p) {
    // Handles of the currently-selected annotation take priority — they sit
    // visually on top of all shapes and are easy to miss without it.
    if (this.selectedIndex != null) {
      const a = this.annotations[this.selectedIndex];
      if (a) {
        const r = HANDLE_HIT_RADIUS * this.scale;
        for (const h of this._handlesFor(a)) {
          if (Math.hypot(p.x - h.x, p.y - h.y) <= r) {
            return {
              index: this.selectedIndex,
              target: "handle:" + h.name,
              cursor: h.cursor,
            };
          }
        }
      }
    }
    // Then bodies, topmost-first (most recently drawn wins).
    for (let i = this.annotations.length - 1; i >= 0; i--) {
      if (this._hitBody(this.annotations[i], p)) {
        return { index: i, target: "body", cursor: "move" };
      }
    }
    return null;
  }

  _hitBody(a, p) {
    const tol = HANDLE_HIT_RADIUS * this.scale;
    if (a.type === "rect") {
      const x1 = Math.min(a.x, a.x + a.w);
      const y1 = Math.min(a.y, a.y + a.h);
      const x2 = Math.max(a.x, a.x + a.w);
      const y2 = Math.max(a.y, a.y + a.h);
      return p.x >= x1 - tol && p.x <= x2 + tol && p.y >= y1 - tol && p.y <= y2 + tol;
    }
    if (a.type === "arrow") {
      return distToSegment(p, a.x, a.y, a.x + a.w, a.y + a.h) <= tol;
    }
    if (a.type === "text") {
      const box = this._textBox(a);
      return (
        p.x >= a.x - tol &&
        p.x <= a.x + box.w + tol &&
        p.y >= a.y - tol &&
        p.y <= a.y + box.h + tol
      );
    }
    return false;
  }

  _handlesFor(a) {
    if (a.type === "rect") {
      const x1 = a.x;
      const y1 = a.y;
      const x2 = a.x + a.w;
      const y2 = a.y + a.h;
      // Cursor names assume top-left to bottom-right; swap diagonals when the
      // rect was drawn "backwards" so the visual cursor still matches.
      const flippedX = a.w < 0;
      const flippedY = a.h < 0;
      const mainDiag = flippedX === flippedY ? "nwse-resize" : "nesw-resize";
      const offDiag = flippedX === flippedY ? "nesw-resize" : "nwse-resize";
      return [
        { name: "tl", x: x1, y: y1, cursor: mainDiag },
        { name: "tr", x: x2, y: y1, cursor: offDiag },
        { name: "br", x: x2, y: y2, cursor: mainDiag },
        { name: "bl", x: x1, y: y2, cursor: offDiag },
      ];
    }
    if (a.type === "arrow") {
      return [
        { name: "start", x: a.x, y: a.y, cursor: "grab" },
        { name: "tip", x: a.x + a.w, y: a.y + a.h, cursor: "grab" },
      ];
    }
    return [];
  }

  _applyDrag(p) {
    const targetRef = this.dragState.targetRef;
    let a;
    if (targetRef === "cropDraft") {
      a = this.cropDraft;
    } else {
      a = this.annotations[this.selectedIndex];
    }
    if (!a) return;
    const o = this.dragState.original;
    const dx = p.x - this.dragState.startPoint.x;
    const dy = p.y - this.dragState.startPoint.y;

    switch (this.dragState.target) {
      case "body":
        a.x = o.x + dx;
        a.y = o.y + dy;
        break;
      case "handle:tl":
        a.x = o.x + dx;
        a.y = o.y + dy;
        a.w = o.w - dx;
        a.h = o.h - dy;
        break;
      case "handle:tr":
        a.y = o.y + dy;
        a.w = o.w + dx;
        a.h = o.h - dy;
        break;
      case "handle:br":
        a.w = o.w + dx;
        a.h = o.h + dy;
        break;
      case "handle:bl":
        a.x = o.x + dx;
        a.w = o.w - dx;
        a.h = o.h + dy;
        break;
      case "handle:start":
        a.x = o.x + dx;
        a.y = o.y + dy;
        a.w = o.w - dx;
        a.h = o.h - dy;
        break;
      case "handle:tip":
        a.w = o.w + dx;
        a.h = o.h + dy;
        break;
    }
  }

  redraw() {
    const { ctx, canvas, image } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    // When a committed crop is active the canvas is sized to crop dims; offset
    // the drawing context so image + annotations (in original-image coords)
    // line up correctly inside the smaller canvas.
    if (this.crop) {
      ctx.translate(-this.crop.x, -this.crop.y);
    }

    if (image) {
      const w = image.width || image.naturalWidth || canvas.width;
      const h = image.height || image.naturalHeight || canvas.height;
      ctx.drawImage(image, 0, 0, w, h);
    }

    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
    ctx.lineWidth = this.strokeWidth;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const all = this.drawing
      ? this.annotations.concat([this.drawing])
      : this.annotations;

    all.forEach((a, i) => {
      // Hide the annotation that's currently being edited in place — the
      // textarea sits on top, and an undersized textarea (after deleting
      // characters) would otherwise expose stale text behind it.
      if (i === this._editingIndex) return;
      if (a.type === "rect") {
        this._drawRect(a);
      } else if (a.type === "arrow") {
        this._drawArrow(a);
      } else if (a.type === "text") {
        this._drawText(a);
      } else if (a.type === "crop") {
        this._drawCropMarquee(a);
      }
    });

    // Crop draft: shown only while the crop tool is active. The marquee dims
    // outside, the handles let the user fine-tune before applying.
    if (this.tool === "crop" && this.cropDraft && !this.drawing) {
      this._drawCropMarquee(this.cropDraft);
      this._drawCropDraftHandles(this.cropDraft);
    }

    if (this.tool === "cursor") this._drawSelection();

    ctx.restore();
  }

  _drawCropDraftHandles(draft) {
    const { ctx } = this;
    ctx.save();
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";
    ctx.fillStyle = HANDLE_FILL;
    ctx.strokeStyle = HANDLE_STROKE;
    ctx.lineWidth = 1.5 * this.scale;
    for (const h of this._handlesFor({ type: "rect", ...draft })) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, HANDLE_RADIUS * this.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  _textBox(a) {
    const fontSize = TEXT_FONT_SIZE * this.scale;
    const lineHeight = fontSize * TEXT_LINE_HEIGHT;
    const padX = TEXT_PAD_X * this.scale;
    const padY = TEXT_PAD_Y * this.scale;
    this.ctx.font = `${TEXT_FONT_WEIGHT} ${fontSize}px ${TEXT_FONT_FAMILY}`;
    const lines = (a.text || "").split("\n");
    const maxWidth = lines.reduce(
      (m, line) => Math.max(m, this.ctx.measureText(line).width),
      0
    );
    const textHeight =
      lines.length === 1 ? fontSize : (lines.length - 1) * lineHeight + fontSize;
    return {
      fontSize,
      lineHeight,
      padX,
      padY,
      lines,
      w: maxWidth + padX * 2,
      h: textHeight + padY * 2,
    };
  }

  _drawText(a) {
    const { ctx } = this;
    this._seed(a);
    const box = this._textBox(a);
    const x1 = a.x, y1 = a.y;
    const x2 = a.x + box.w, y2 = a.y + box.h;

    ctx.save();

    // 1. Wobbly closed-path fill — each edge bows slightly so the box doesn't
    //    look ruler-straight against the multi-pass arrows and rectangles.
    const fillRand = mulberry32(a.seed);
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    this._wobblyEdgeTo(fillRand, x1, y1, x2, y1);
    this._wobblyEdgeTo(fillRand, x2, y1, x2, y2);
    this._wobblyEdgeTo(fillRand, x2, y2, x1, y2);
    this._wobblyEdgeTo(fillRand, x1, y2, x1, y1);
    ctx.closePath();
    ctx.fill();

    // 2. Multi-pass sketchy strokes per edge in the same red as the fill —
    //    they don't show inside the box, but the per-pass endpoint nudges and
    //    bow extend the silhouette slightly past the fill in random directions,
    //    giving the outer edge the same hand-drawn texture as the V5 rect.
    const strokeRand = mulberry32((a.seed ^ 0xdeadbeef) >>> 0);
    ctx.strokeStyle = this.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    this._sketchSegment(strokeRand, x1, y1, x2, y1, SKETCH_PASSES_TEXT_EDGE);
    this._sketchSegment(strokeRand, x2, y1, x2, y2, SKETCH_PASSES_TEXT_EDGE);
    this._sketchSegment(strokeRand, x2, y2, x1, y2, SKETCH_PASSES_TEXT_EDGE);
    this._sketchSegment(strokeRand, x1, y2, x1, y1, SKETCH_PASSES_TEXT_EDGE);

    // 3. White text on top
    ctx.fillStyle = TEXT_FG;
    ctx.font = `${TEXT_FONT_WEIGHT} ${box.fontSize}px ${TEXT_FONT_FAMILY}`;
    ctx.textBaseline = "top";
    for (let i = 0; i < box.lines.length; i++) {
      ctx.fillText(
        box.lines[i],
        a.x + box.padX,
        a.y + box.padY + i * box.lineHeight
      );
    }
    ctx.restore();
  }

  // Append a slightly-bowed quadratic curve from the current path point to
  // (x2, y2). Used to build the wobbly fill outline of a text box.
  _wobblyEdgeTo(rand, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 1) {
      this.ctx.lineTo(x2, y2);
      return;
    }
    const px = -dy / len, py = dx / len;
    const ctrlOff = (rand() - 0.5) * TEXT_FILL_BOW_MAX * this.scale;
    const t = 0.5 + (rand() - 0.5) * 0.1;
    const cx = x1 + dx * t + px * ctrlOff;
    const cy = y1 + dy * t + py * ctrlOff;
    this.ctx.quadraticCurveTo(cx, cy, x2, y2);
  }

  _drawSelection() {
    if (this.selectedIndex == null) return;
    if (this.selectedIndex === this._editingIndex) return;
    const a = this.annotations[this.selectedIndex];
    if (!a) return;

    const { ctx } = this;
    ctx.save();
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";

    ctx.fillStyle = HANDLE_FILL;
    ctx.strokeStyle = HANDLE_STROKE;
    ctx.lineWidth = 1.5 * this.scale;
    for (const h of this._handlesFor(a)) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, HANDLE_RADIUS * this.scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  _drawCropMarquee(a) {
    const { ctx, canvas } = this;
    const x = Math.min(a.x, a.x + a.w);
    const y = Math.min(a.y, a.y + a.h);
    const w = Math.abs(a.w);
    const h = Math.abs(a.h);
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, canvas.width, y);
    ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, canvas.width - x - w, h);
    ctx.lineWidth = 2 * this.scale;
    ctx.setLineDash([8 * this.scale, 6 * this.scale]);
    ctx.strokeStyle = "#ffffff";
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawRect(a) {
    this._seed(a);
    const rand = mulberry32(a.seed);
    const x1 = a.x, y1 = a.y;
    const x2 = a.x + a.w, y2 = a.y + a.h;
    this._sketchSegment(rand, x1, y1, x2, y1, SKETCH_PASSES_SHAFT);
    this._sketchSegment(rand, x2, y1, x2, y2, SKETCH_PASSES_SHAFT);
    this._sketchSegment(rand, x2, y2, x1, y2, SKETCH_PASSES_SHAFT);
    this._sketchSegment(rand, x1, y2, x1, y1, SKETCH_PASSES_SHAFT);
  }

  _drawArrow(a) {
    const x1 = a.x, y1 = a.y;
    const x2 = a.x + a.w, y2 = a.y + a.h;
    const len = Math.hypot(a.w, a.h);
    if (len < 1) return;

    this._seed(a);
    const rand = mulberry32(a.seed);

    this._sketchSegment(rand, x1, y1, x2, y2, SKETCH_PASSES_SHAFT);

    // Open V arrowhead aligned with the shaft's straight-line angle.
    const tipAngle = Math.atan2(y2 - y1, x2 - x1);
    const head = ARROW_HEAD * this.scale;
    this._sketchSegment(
      rand,
      x2 - head * Math.cos(tipAngle - ARROW_HEAD_ANGLE),
      y2 - head * Math.sin(tipAngle - ARROW_HEAD_ANGLE),
      x2,
      y2,
      SKETCH_PASSES_HEAD
    );
    this._sketchSegment(
      rand,
      x2,
      y2,
      x2 - head * Math.cos(tipAngle + ARROW_HEAD_ANGLE),
      y2 - head * Math.sin(tipAngle + ARROW_HEAD_ANGLE),
      SKETCH_PASSES_HEAD
    );
  }

  // Multi-pass sketchy stroke from (x1,y1) to (x2,y2). Each pass picks its own
  // random bow direction, control-point t-shift, and tiny perpendicular nudges
  // at both endpoints, so the same edge is traced 2–3 times slightly differently.
  _sketchSegment(rand, x1, y1, x2, y2, passes) {
    const { ctx } = this;
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (len < 1) return;
    const px = -dy / len, py = dx / len;
    ctx.lineWidth = STROKE_WIDTH * SKETCH_LINE_WIDTH_RATIO * this.scale;
    for (let i = 0; i < passes; i++) {
      const aStart = (rand() - 0.5) * SKETCH_ENDPOINT_JITTER * this.scale;
      const aEnd = (rand() - 0.5) * SKETCH_ENDPOINT_JITTER * this.scale;
      const ctrlOff = (rand() - 0.5) * SKETCH_BOW_MAX * this.scale;
      const tShift = 0.5 + (rand() - 0.5) * SKETCH_T_JITTER;
      const cx = x1 + dx * tShift + px * ctrlOff;
      const cy = y1 + dy * tShift + py * ctrlOff;
      ctx.beginPath();
      ctx.moveTo(x1 + px * aStart, y1 + py * aStart);
      ctx.quadraticCurveTo(cx, cy, x2 + px * aEnd, y2 + py * aEnd);
      ctx.stroke();
    }
  }

  _seed(a) {
    if (a.seed == null) {
      a.seed = (Math.imul(a.x | 0, 73856093) ^ Math.imul(a.y | 0, 19349663)) >>> 0;
    }
  }
}
