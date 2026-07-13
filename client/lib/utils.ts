import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Workspace } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getWorkspaceDisplayName(workspace: Workspace): string {
  return workspace.name === "untitled"
    ? `project-${workspace._id.substring(0, 5)}`
    : workspace.name;
}
