import crypto from "crypto";
import { Todo, TodoStatus, UUID, nowMs } from "./protocol";

type WorkspaceId = string;

export class TodoStore {
  private readonly todosByWorkspace = new Map<WorkspaceId, Map<UUID, Todo>>();

  create(input: {
    workspaceId: string;
    title: string;
    description?: string;
    priority?: Todo["priority"];
    dueAt?: number;
    userId?: string;
  }): Todo {
    const ts = nowMs();
    const todo: Todo = {
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      description: input.description,
      status: "open",
      priority: input.priority,
      dueAt: input.dueAt,
      createdAt: ts,
      updatedAt: ts,
      createdBy: input.userId,
      updatedBy: input.userId,
    };

    const bucket = this.ensureBucket(input.workspaceId);
    bucket.set(todo.id, todo);
    return todo;
  }

  update(input: {
    workspaceId: string;
    id: UUID;
    patch: Partial<Pick<Todo, "title" | "description" | "priority">> & { dueAt?: number | null; description?: string };
    userId?: string;
  }): Todo | null {
    const bucket = this.todosByWorkspace.get(input.workspaceId);
    const current = bucket?.get(input.id);
    if (!current) return null;

    const ts = nowMs();
    const next: Todo = { ...current };
    if (typeof input.patch.title === "string") next.title = input.patch.title;
    if (typeof input.patch.description === "string") next.description = input.patch.description;
    if (input.patch.description === undefined) {
      // no-op
    }
    if (input.patch.priority !== undefined) next.priority = input.patch.priority;
    if (input.patch.dueAt === null) next.dueAt = undefined;
    else if (typeof input.patch.dueAt === "number") next.dueAt = input.patch.dueAt;
    next.updatedAt = ts;
    next.updatedBy = input.userId;
    bucket!.set(input.id, next);
    return next;
  }

  setCompleted(input: {
    workspaceId: string;
    id: UUID;
    completed: boolean;
    userId?: string;
  }): Todo | null {
    const status: TodoStatus = input.completed ? "completed" : "open";
    const bucket = this.todosByWorkspace.get(input.workspaceId);
    const current = bucket?.get(input.id);
    if (!current) return null;
    const ts = nowMs();
    const next: Todo = { ...current, status, updatedAt: ts, updatedBy: input.userId };
    bucket!.set(input.id, next);
    return next;
  }

  delete(input: { workspaceId: string; id: UUID }): boolean {
    const bucket = this.todosByWorkspace.get(input.workspaceId);
    if (!bucket) return false;
    return bucket.delete(input.id);
  }

  list(input: { workspaceId: string; status?: TodoStatus }): Todo[] {
    const bucket = this.todosByWorkspace.get(input.workspaceId);
    if (!bucket) return [];
    const all = [...bucket.values()];
    const filtered = input.status ? all.filter((t) => t.status === input.status) : all;
    // stable-ish ordering
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    return filtered;
  }

  private ensureBucket(workspaceId: string) {
    let bucket = this.todosByWorkspace.get(workspaceId);
    if (!bucket) {
      bucket = new Map();
      this.todosByWorkspace.set(workspaceId, bucket);
    }
    return bucket;
  }
}
