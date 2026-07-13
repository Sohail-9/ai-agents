"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { X, ChevronDown, Code2, AlignLeft, AlignCenter, AlignRight, AlignJustify, Pencil } from "lucide-react";

export interface BreadcrumbNode {
  tagName: string;
  classShorthand: string;
  selector: string;
  classes: string[];
}

export interface SelectedElement {
  selector: string;
  tagName: string;
  computedStyle: Record<string, string>;
  rect: { top: number; left: number; width: number; height: number };
  breadcrumb: BreadcrumbNode[];
  hasEditableText: boolean;
  currentText: string;
  classes: string[];
  src: string;
}

interface VisualEditorPanelProps {
  element: SelectedElement | null;
  pendingChanges: Record<string, string>;
  externalText?: string | null;
  hasPendingChanges: boolean;
  onStyleChange: (prop: string, value: string) => void;
  onTextChange: (text: string) => void;
  onSrcChange: (src: string) => void;
  onClimbToAncestor: (depth: number) => void;
  onApplyToCode: () => void;
  onReset: () => void;
  onExit: () => void;
  isApplying: boolean;
}

// ─── Section divider ─────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-4 border-b border-white/[0.06]">
      <p className="text-white text-[14px] font-semibold mb-3">{title}</p>
      {children}
    </div>
  );
}

// ─── Color row ────────────────────────────────────────────────────────────────
function ColorRow({ label, prop, value, onChange }: { label: string; prop: string; value: string; onChange: (p: string, v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const raw = value || "#ffffff";
  const hex = raw.startsWith("#") && raw.length >= 7 ? raw.slice(1, 7).toUpperCase() : "FFFFFF";

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-white/55 text-[12.5px]">{label}</span>
      <div className="flex items-center gap-2">
        <input ref={inputRef} type="color"
          value={raw.startsWith("#") && raw.length === 7 ? raw : "#ffffff"}
          onChange={(e) => onChange(prop, e.target.value)}
          className="sr-only"
        />
        <button
          onClick={() => inputRef.current?.click()}
          className="w-4 h-4 rounded-sm border border-white/20 shrink-0"
          style={{ backgroundColor: raw }}
        />
        <span className="text-white/70 text-[12px] font-mono w-14">{hex}</span>
        <span className="text-white/40 text-[12px] w-8 text-right">100%</span>
        <button onClick={() => inputRef.current?.click()} className="text-white/25 hover:text-white/60 transition-colors">
          <Pencil size={11} />
        </button>
      </div>
    </div>
  );
}

// ─── Pill select ──────────────────────────────────────────────────────────────
function PillSelect({ value, options, onChange }: {
  value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center bg-[#252525] rounded-lg p-0.5 gap-0.5">
      {options.map(opt => (
        <button key={opt} onClick={() => onChange(opt)}
          className={`flex-1 px-2 py-1 rounded-md text-[11.5px] font-medium transition-all ${
            value === opt ? "bg-[#FF15DC]/20 text-[#FF15DC]" : "text-white/40 hover:text-white/70"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

// ─── Dark dropdown ─────────────────────────────────────────────────────────────
function DarkSelect({ value, options, onChange, className = "" }: {
  value: string; options: string[]; onChange: (v: string) => void; className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full appearance-none bg-[#252525] text-white/80 text-[12px] rounded-lg px-3 py-2 pr-7 outline-none border border-white/[0.07] cursor-pointer"
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none" />
    </div>
  );
}

// ─── Small pill input ─────────────────────────────────────────────────────────
function PillInput({ label, value, unit = "", onChange }: {
  label: string; value: string; unit?: string; onChange: (v: string) => void;
}) {
  const num = parseFloat(value) || 0;
  const display = unit ? `${num}${unit}` : `${num}`;
  return (
    <div className="flex-1 flex flex-col gap-1">
      <span className="text-white/40 text-[11px]">{label}</span>
      <div className="bg-[#252525] rounded-lg px-3 py-2 border border-white/[0.07]">
        <input
          type="number"
          value={num}
          onChange={e => onChange(unit ? `${e.target.value}${unit}` : e.target.value)}
          className="w-full bg-transparent text-white/80 text-[12px] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
      </div>
    </div>
  );
}

// ─── Spacing box model ────────────────────────────────────────────────────────
function SpacingBox({ values, onChange }: {
  values: Record<string, string>;
  onChange: (prop: string, val: string) => void;
}) {
  const box = (prop: string) => (
    <input
      type="number"
      value={parseFloat(values[prop]) || 0}
      onChange={e => onChange(prop, `${e.target.value}px`)}
      className="w-9 h-7 bg-[#333] rounded text-white/70 text-[11px] text-center outline-none border border-white/10 focus:border-white/25 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
    />
  );

  return (
    <div className="flex flex-col items-center gap-1 py-1">
      <div className="text-white/30 text-[10px] self-end pr-2">Margin</div>
      <div className="flex flex-col items-center gap-1 w-full">
        <div className="flex justify-center">{box("marginTop")}</div>
        <div className="flex items-center justify-center gap-2 w-full">
          {box("marginLeft")}
          <div className="flex flex-col items-center gap-1 border border-white/10 rounded-lg p-2 flex-1">
            <div className="text-white/25 text-[10px] self-end pr-1">Padding</div>
            <div className="flex justify-center">{box("paddingTop")}</div>
            <div className="flex items-center gap-4 justify-center">
              {box("paddingLeft")}
              <div className="w-8 h-8 rounded-md bg-white/5 border border-white/10" />
              {box("paddingRight")}
            </div>
            <div className="flex justify-center">{box("paddingBottom")}</div>
          </div>
          {box("marginRight")}
        </div>
        <div className="flex justify-center">{box("marginBottom")}</div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function VisualEditorPanel({
  element, pendingChanges, externalText, hasPendingChanges, onStyleChange, onTextChange, onSrcChange,
  onClimbToAncestor, onApplyToCode, onReset, onExit, isApplying,
}: VisualEditorPanelProps) {
  const [localText, setLocalText] = useState("");
  const [localSrc, setLocalSrc] = useState("");
  const textDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (element) { setLocalText(element.currentText || ""); setLocalSrc(element.src || ""); }
  }, [element?.selector]);

  useEffect(() => {
    if (typeof externalText === "string") setLocalText(externalText);
  }, [externalText]);

  const handleTextChange = useCallback((val: string) => {
    setLocalText(val);
    if (textDebounce.current) clearTimeout(textDebounce.current);
    textDebounce.current = setTimeout(() => onTextChange(val), 300);
  }, [onTextChange]);

  const get = (prop: string) => pendingChanges[prop] ?? element?.computedStyle[prop] ?? "";

  const spacingValues = {
    paddingTop: get("paddingTop"), paddingRight: get("paddingRight"),
    paddingBottom: get("paddingBottom"), paddingLeft: get("paddingLeft"),
    marginTop: get("marginTop"), marginRight: get("marginRight"),
    marginBottom: get("marginBottom"), marginLeft: get("marginLeft"),
  };

  if (!element) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-center px-6">
        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center">
          <Code2 size={20} className="text-white/30" />
        </div>
        <p className="text-white/30 text-sm">Click any element in the preview to edit it</p>
      </div>
    );
  }

  const tagLabel = `${element.tagName}${element.classes?.[0] ? `.${element.classes[0]}` : ""}`;
  const fontWeight = get("fontWeight") || "400";
  const textAlign = get("textAlign") || "left";
  const borderStyle = get("borderStyle") || "none";
  const shadow = get("boxShadow") || "none";
  const opacity = Math.round((parseFloat(get("opacity")) || 1) * 100);

  const alignIcons = [
    { value: "left", icon: <AlignLeft size={13} /> },
    { value: "center", icon: <AlignCenter size={13} /> },
    { value: "right", icon: <AlignRight size={13} /> },
    { value: "justify", icon: <AlignJustify size={13} /> },
  ];

  return (
    <div className="flex flex-col h-full text-sm bg-[#1a1a1a]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.07]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full bg-[#FF15DC] shrink-0" />
          <span className="text-white/90 text-[13px] font-medium font-mono truncate">{tagLabel}</span>
          <ChevronDown size={12} className="text-white/30 shrink-0" />
        </div>
        <button onClick={onExit} className="text-white/30 hover:text-white/70 transition-colors shrink-0">
          <X size={15} />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto scrollbar-none">

        {/* Text content */}
        {element.hasEditableText && (
          <div className="px-4 py-4 border-b border-white/[0.06]">
            <p className="text-white text-[14px] font-semibold mb-3">Content</p>
            <textarea
              value={localText}
              onChange={e => handleTextChange(e.target.value)}
              rows={3}
              className="w-full bg-[#252525] border border-white/[0.07] rounded-lg px-3 py-2 text-[12px] text-white/80 outline-none focus:border-white/20 resize-none"
            />
          </div>
        )}

        {/* Image src */}
        {element.tagName === "img" && (
          <div className="px-4 py-4 border-b border-white/[0.06]">
            <p className="text-white text-[14px] font-semibold mb-3">Image Source</p>
            <input
              type="text" value={localSrc}
              onChange={e => { setLocalSrc(e.target.value); onSrcChange(e.target.value); }}
              placeholder="https://..."
              className="w-full bg-[#252525] border border-white/[0.07] rounded-lg px-3 py-2 text-[12px] text-white/80 font-mono outline-none focus:border-white/20"
            />
          </div>
        )}

        {/* Colors */}
        <Section title="Colors">
          <ColorRow label="Text" prop="color" value={get("color")} onChange={onStyleChange} />
          <ColorRow label="Background" prop="backgroundColor" value={get("backgroundColor")} onChange={onStyleChange} />
          <ColorRow label="Border" prop="borderColor" value={get("borderColor")} onChange={onStyleChange} />
        </Section>

        {/* Typography */}
        <Section title="Typography">
          <div className="flex flex-col gap-3">
            {/* Font family */}
            <div className="flex items-center justify-between">
              <span className="text-white/55 text-[12.5px] shrink-0 w-20">Font</span>
              <DarkSelect
                value={get("fontFamily")?.split(",")[0].trim().replace(/['"]/g, "") || "Inter"}
                options={["Inter", "system-ui", "monospace", "serif", "sans-serif", "Roboto", "Poppins", "DM Sans"]}
                onChange={v => onStyleChange("fontFamily", v)}
                className="flex-1"
              />
            </div>
            {/* Font size */}
            <div className="flex items-center justify-between">
              <span className="text-white/55 text-[12.5px] shrink-0 w-20">Font Size</span>
              <DarkSelect
                value={`${parseFloat(get("fontSize")) || 16}`}
                options={["10","11","12","13","14","15","16","18","20","22","24","28","32","36","40","48","56","64","72","96"]}
                onChange={v => onStyleChange("fontSize", `${v}px`)}
                className="flex-1"
              />
            </div>
            {/* Weight */}
            <div className="flex items-center justify-between">
              <span className="text-white/55 text-[12.5px] shrink-0 w-20">Weight</span>
              <div className="flex-1">
                <PillSelect
                  value={fontWeight}
                  options={["400","500","600","700","800"]}
                  onChange={v => onStyleChange("fontWeight", v)}
                />
              </div>
            </div>
            {/* Align */}
            <div className="flex items-center justify-between">
              <span className="text-white/55 text-[12.5px] shrink-0 w-20">Align</span>
              <div className="flex items-center bg-[#252525] rounded-lg p-0.5 gap-0.5 flex-1">
                {alignIcons.map(({ value, icon }) => (
                  <button key={value} onClick={() => onStyleChange("textAlign", value)}
                    className={`flex-1 flex items-center justify-center py-1 rounded-md transition-all ${
                      textAlign === value ? "bg-[#FF15DC]/20 text-[#FF15DC]" : "text-white/40 hover:text-white/70"
                    }`}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
            {/* Line height + letter spacing */}
            <div className="flex gap-3">
              <PillInput label="Line Height" value={get("lineHeight")} onChange={v => onStyleChange("lineHeight", v)} />
              <PillInput label="Letter Spacing" value={get("letterSpacing")} unit="px" onChange={v => onStyleChange("letterSpacing", v)} />
            </div>
          </div>
        </Section>

        {/* Spacing */}
        <Section title="Spacing">
          <SpacingBox values={spacingValues} onChange={onStyleChange} />
        </Section>

        {/* Border */}
        <Section title="Border">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <div className="flex-1 flex flex-col gap-1">
                <span className="text-white/40 text-[11px]">Width</span>
                <DarkSelect
                  value={`${parseFloat(get("borderWidth")) || 0}`}
                  options={["0","1","2","3","4","5","6","8","10","12","16","20"]}
                  onChange={v => onStyleChange("borderWidth", `${v}px`)}
                />
              </div>
              <div className="flex-1 flex flex-col gap-1">
                <span className="text-white/40 text-[11px]">Radius</span>
                <DarkSelect
                  value={`${parseFloat(get("borderRadius")) || 0}`}
                  options={["0","2","4","5","6","8","10","12","16","20","24","9999"]}
                  onChange={v => onStyleChange("borderRadius", `${v}px`)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-white/40 text-[11px]">Style</span>
              <PillSelect
                value={borderStyle}
                options={["none","solid","dashed","dotted"]}
                onChange={v => onStyleChange("borderStyle", v)}
              />
            </div>
          </div>
        </Section>

        {/* Effects */}
        <Section title="Effects">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-white/55 text-[12.5px]">Opacity</span>
              <div className="bg-[#252525] rounded-lg px-3 py-2 border border-white/[0.07] flex items-center gap-2">
                <span className="text-white/30 text-[11px]">◉</span>
                <input
                  type="number" min={0} max={100} value={opacity}
                  onChange={e => onStyleChange("opacity", `${Number(e.target.value) / 100}`)}
                  className="w-10 bg-transparent text-white/80 text-[12px] outline-none text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-white/40 text-[12px]">%</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-white/40 text-[11px]">Shadow</span>
              <PillSelect
                value={shadow === "none" || !shadow ? "none" : shadow.includes("10px") ? "lg" : shadow.includes("4px") ? "md" : "sm"}
                options={["none","sm","md","lg"]}
                onChange={v => onStyleChange("boxShadow", {
                  none: "none",
                  sm: "0 1px 2px rgba(0,0,0,0.2)",
                  md: "0 4px 6px rgba(0,0,0,0.2)",
                  lg: "0 10px 15px rgba(0,0,0,0.25)",
                }[v] || "none")}
              />
            </div>
          </div>
        </Section>

      </div>
    </div>
  );
}
