import { prisma } from '../lib/prisma';

export const todoService = {
  // Create a todo (low-level — use createTodosWithDeps for batches with dependencies)
  createTodo: async (todoData: {
    workspaceId: string;
    title: string;
    description: string;
    order: number;
    dependencies?: string[];
  }) => {
    const { workspaceId, title, description, order, dependencies } = todoData;

    try {
      return await prisma.todo.create({
        data: {
          workspaceId,
          title,
          description,
          order,
          status: 'pending',
          ...(dependencies?.length ? { dependencies } : {}),
        },
      });
    } catch (error) {
      console.error('[Prisma] createTodo failed:', error);
      throw error;
    }
  },

  /**
   * Two-phase batch creation that wires dependency IDs.
   * `deps` are 1-based indices into the `todos` array (matching TOON [N] order).
   */
  createTodosWithDeps: async (
    workspaceId: string,
    todos: Array<{ title: string; description: string; deps?: number[] }>,
    startOrder = 1,
  ) => {
    // Phase 1: insert all todos without dependencies
    const created = await Promise.all(
      todos.map((todo, i) =>
        prisma.todo.create({
          data: {
            workspaceId,
            title: todo.title,
            description: todo.description,
            order: startOrder + i,
            status: 'pending',
          },
        }),
      ),
    );

    // Phase 2: resolve 1-based dep indices to CUIDs, then update
    const updates = created
      .map((todo, i) => {
        const depIndices = todos[i].deps ?? [];
        if (depIndices.length === 0) return null;
        const depIds = depIndices
          .map((idx) => created[idx - 1]?.id)
          .filter((id): id is string => !!id);
        if (depIds.length === 0) return null;
        return prisma.todo.update({ where: { id: todo.id }, data: { dependencies: depIds } });
      })
      .filter(Boolean);

    if (updates.length > 0) await Promise.all(updates);
    return created;
  },

  // Get current pending todo (the one with lowest order number) — used by multi-agent classifier
  getCurrentTodo: async (workspaceId: string) => {
    try {
      return await prisma.todo.findFirst({
        where: {
          workspaceId,
          status: 'pending',
        },
        orderBy: { order: 'asc' },
      });
    } catch (error) {
      console.error('[Prisma] getCurrentTodo failed:', error);
      throw error;
    }
  },

  /**
   * Returns all pending todos whose dependencies are all completed.
   * These form the current execution wave.
   *
   * Also detects deadlocks: if pending todos exist but none are ready
   * (circular deps or stuck in_progress deps), returns the blocked todos
   * with `deadlocked: true` so the caller can force-break the cycle.
   */
  getReadyTodos: async (workspaceId: string): Promise<Array<{ id: string; title: string; description: string; order: number; dependencies: string[]; deadlocked?: boolean }>> => {
    try {
      const [pending, completed] = await Promise.all([
        prisma.todo.findMany({
          where: { workspaceId, status: 'pending' },
          orderBy: { order: 'asc' },
        }),
        prisma.todo.findMany({
          where: { workspaceId, status: 'completed' },
          select: { id: true },
        }),
      ]);

      if (pending.length === 0) return [];

      const completedIds = new Set(completed.map((t) => t.id));

      // Ready: all deps are completed (strictly — not just in_progress)
      const ready = pending.filter((t) =>
        (t.dependencies as string[]).every((depId) => completedIds.has(depId)),
      );

      if (ready.length > 0) return ready;

      // Deadlock: pending todos exist but none are ready
      // Force-unblock the lowest-order pending todo to break the cycle
      console.warn(`[todoService] ⚠️ Deadlock detected — ${pending.length} pending todos but 0 ready. Force-breaking with lowest-order todo.`);
      return [{ ...pending[0], deadlocked: true }];
    } catch (error) {
      console.error('[Prisma] getReadyTodos failed:', error);
      throw error;
    }
  },

  // List all pending todos
  listPendingTodos: async (workspaceId: string) => {
    try {
      return await prisma.todo.findMany({
        where: {
          workspaceId,
          status: 'pending',
        },
        orderBy: { order: 'asc' },
      });
    } catch (error) {
      console.error('[Prisma] listPendingTodos failed:', error);
      throw error;
    }
  },

  // Mark a todo as in-progress
  markInProgress: async (todoId: string) => {
    try {
      return await prisma.todo.update({
        where: { id: todoId },
        data: { status: 'in_progress' },
      });
    } catch (error) {
      console.error('[Prisma] markInProgress failed:', error);
      throw error;
    }
  },

  // Mark a todo as complete
  markComplete: async (todoId: string, notes?: string) => {
    try {
      const todo = await prisma.todo.findUnique({
        where: { id: todoId },
      });

      if (!todo) {
        throw new Error(`Todo ${todoId} not found.`);
      }

      if (todo.status === 'completed') {
        return todo;
      }

      let updatedDescription = todo.description;
      if (notes) {
        updatedDescription = `${todo.description}\n\nNotes: ${notes}`;
      }

      return await prisma.todo.update({
        where: { id: todoId },
        data: {
          status: 'completed',
          description: updatedDescription,
        },
      });
    } catch (error) {
      console.error('[Prisma] markComplete failed:', error);
      throw error;
    }
  },

  // List ALL todos for a workspace (pending + completed) — for frontend display
  listAllTodos: async (workspaceId: string) => {
    try {
      return await prisma.todo.findMany({
        where: { workspaceId },
        orderBy: { order: 'asc' },
      });
    } catch (error) {
      console.error('[Prisma] listAllTodos failed:', error);
      throw error;
    }
  },

  // Delete ALL todos for a workspace (to refresh on new agent run)
  deleteAllTodos: async (workspaceId: string) => {
    try {
      return await prisma.todo.deleteMany({
        where: { workspaceId },
      });
    } catch (error) {
      console.error('[Prisma] deleteAllTodos failed:', error);
      throw error;
    }
  },
};