import * as React from "react";

const MIN_WIDTH = 320;
const MAX_WIDTH = 800;

interface UsePanelResizeResult {
    chatWidth: number;
    isResizing: boolean;
    containerRef: React.MutableRefObject<HTMLDivElement | null>;
    handleMouseDown: (e: React.MouseEvent) => void;
}

export function usePanelResize(): UsePanelResizeResult {
    const [chatWidth, setChatWidth] = React.useState(650);
    const [isResizing, setIsResizing] = React.useState(false);
    const containerRef = React.useRef<HTMLDivElement>(null);

    const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.body.style.pointerEvents = "none";
    }, []);

    React.useEffect(() => {
        if (!isResizing) return;

        const handleMouseMove = (e: MouseEvent) => {
            if (!containerRef.current) return;
            e.preventDefault();
            const rect = containerRef.current.getBoundingClientRect();
            setChatWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX - rect.left)));
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.body.style.pointerEvents = "";
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);

        return () => {
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.body.style.pointerEvents = "";
        };
    }, [isResizing]);

    return { chatWidth, isResizing, containerRef, handleMouseDown };
}
