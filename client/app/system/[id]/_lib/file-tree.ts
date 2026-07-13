import type { FileNode } from "../_types/system";

function normalizePath(input: string): string {
    if (!input) return "";
    return input
        .replace(/\\/g, "/")
        .replace(/\/+/g, "/")
        .replace(/\/$/, "")
        .replace(/^\/+/, "")
        .trim();
}

function toRelativePath(path: string, root: string): string {
    const p = normalizePath(path);
    const r = normalizePath(root);

    if (!p) return "";
    if (r && p === r) return "";
    if (r && p.startsWith(`${r}/`)) return p.slice(r.length + 1);
    return p.replace(/^\/+/, "");
}

function sortTree(nodes: FileNode[]): FileNode[] {
    const sorted = [...nodes].sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.path.localeCompare(b.path);
    });

    sorted.forEach((n) => {
        if (n.children) n.children = sortTree(n.children);
    });

    return sorted;
}

function markOpenPaths(nodes: FileNode[], openPaths: Set<string>) {
    for (const node of nodes) {
        if (node.type === "directory") {
            node.isOpen = openPaths.has(node.path);
            if (node.children) markOpenPaths(node.children, openPaths);
        }
    }
}

export function buildTree(flat: FileNode[], root: string = "", preferredOpenPaths: string[] = []): FileNode[] {
    const rootNode: FileNode = { path: "", type: "directory", children: [], isOpen: true };
    const map = new Map<string, FileNode>();
    map.set("", rootNode);

    const paths = new Set<string>();

    for (const rawEntry of flat) {
        const relPath = toRelativePath(rawEntry.path, root);
        if (!relPath) continue;

        const cleaned = relPath.replace(/\/$/, "");
        if (!cleaned) continue;

        const isDir = rawEntry.type === "directory" || rawEntry.path.endsWith("/");
        paths.add(cleaned);

        const segments = cleaned.split("/");
        for (let i = 1; i < segments.length; i++) {
            paths.add(segments.slice(0, i).join("/"));
        }

        if (!map.has(cleaned)) {
            map.set(cleaned, {
                path: cleaned,
                type: isDir ? "directory" : "file",
                children: isDir ? [] : undefined,
            });
        } else {
            const existing = map.get(cleaned)!;
            if (isDir && existing.type !== "directory") {
                existing.type = "directory";
                existing.children = existing.children || [];
            }
        }
    }

    for (const relPath of [...paths].sort((a, b) => a.localeCompare(b))) {
        const node = map.get(relPath) || {
            path: relPath,
            type: "directory" as const,
            children: [],
        };

        if (!map.has(relPath)) map.set(relPath, node);

        const parentPath = relPath.includes("/")
            ? relPath.slice(0, relPath.lastIndexOf("/"))
            : "";

        const parent = map.get(parentPath) || rootNode;
        if (!parent.children) parent.children = [];

        if (!parent.children.find((c) => c.path === node.path)) {
            parent.children.push(node);
        }
    }

    const tree = sortTree(rootNode.children || []);

    if (preferredOpenPaths.length > 0) {
        const normalizedOpenPaths = new Set(preferredOpenPaths.map((p) => normalizePath(p).replace(/^\/+/, "")));
        markOpenPaths(tree, normalizedOpenPaths);
    }

    return tree;
}
