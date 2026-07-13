import { Router } from 'express';
import { supportCaseService } from '../services/supportCaseService';
import { escalationService } from '../services/escalationService';
import { supportQueue } from '../queue/queues';
import { SupportMessageRole } from '../../generated/prisma';
import { prisma } from '../lib/prisma';

const router = Router();

// POST /api/support/cases — create a new support case
router.post('/cases', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { message, workspaceId } = req.body as { message: string; workspaceId?: string };

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    if (workspaceId) {
      const ws = await prisma.workspace.findFirst({ where: { id: workspaceId, userId } });
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    }

    const supportCase = await supportCaseService.createCase(userId, message.trim(), workspaceId);

    await supportQueue.add('process', { caseId: supportCase.id, userId });

    res.status(201).json(supportCase);
  } catch (err) {
    console.error('[Support] POST /cases failed:', err);
    res.status(500).json({ error: 'Failed to create support case' });
  }
});

// GET /api/support/cases/count — open + escalated count for nav badge
router.get('/cases/count', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const count = await supportCaseService.getOpenCaseCount(userId);
    res.json({ count });
  } catch (err) {
    console.error('[Support] GET /cases/count failed:', err);
    res.status(500).json({ error: 'Failed to get case count' });
  }
});

// GET /api/support/cases — list user's cases
router.get('/cases', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { status } = req.query as { status?: string };
    const validStatuses = ['OPEN', 'RESOLVED', 'CLOSED', 'ESCALATED'];
    const statusFilter = status && validStatuses.includes(status) ? (status as any) : undefined;
    const cases = await supportCaseService.getCasesByUser(userId, statusFilter);
    res.json(cases);
  } catch (err) {
    console.error('[Support] GET /cases failed:', err);
    res.status(500).json({ error: 'Failed to list cases' });
  }
});

// GET /api/support/cases/:caseId — get a specific case with all messages
router.get('/cases/:caseId', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { caseId } = req.params;
    const supportCase = await supportCaseService.getCaseById(caseId, userId);
    if (!supportCase) return res.status(404).json({ error: 'Case not found' });
    res.json(supportCase);
  } catch (err: any) {
    if (err?.status === 403) return res.status(403).json({ error: 'Forbidden' });
    console.error('[Support] GET /cases/:caseId failed:', err);
    res.status(500).json({ error: 'Failed to get case' });
  }
});

// POST /api/support/cases/:caseId/messages — add a user message and trigger agent
router.post('/cases/:caseId/messages', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { caseId } = req.params;
    const { message } = req.body as { message: string };

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const supportCase = await supportCaseService.getCaseById(caseId, userId);
    if (!supportCase) return res.status(404).json({ error: 'Case not found' });

    if (supportCase.status === 'CLOSED') {
      return res.status(400).json({ error: 'Cannot add messages to a closed case' });
    }

    const msg = await supportCaseService.addMessage(caseId, SupportMessageRole.USER, message.trim());

    if (supportCase.status === 'RESOLVED') {
      await supportCaseService.updateStatus(caseId, 'OPEN');
    }

    await supportQueue.add('process', { caseId, userId });

    res.status(201).json(msg);
  } catch (err: any) {
    if (err?.status === 403) return res.status(403).json({ error: 'Forbidden' });
    console.error('[Support] POST /cases/:caseId/messages failed:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /api/support/cases/:caseId/escalate — manual user escalation
router.post('/cases/:caseId/escalate', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { caseId } = req.params;

    const supportCase = await supportCaseService.getCaseById(caseId, userId);
    if (!supportCase) return res.status(404).json({ error: 'Case not found' });
    if (supportCase.status === 'CLOSED') {
      return res.status(400).json({ error: 'Cannot escalate a closed case' });
    }

    const firstUserMsg = supportCase.messages.find((m) => m.role === SupportMessageRole.USER);
    const historyText = supportCase.messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    const user = await prisma.user.findUnique({
      where: { clerkId: userId },
      select: { email: true, name: true },
    });

    await supportCaseService.updateStatus(caseId, 'ESCALATED', {
      escalationNote: 'Manually escalated by user',
    });

    try {
      await escalationService.sendEscalationEmail({
        caseId,
        caseNumber: supportCase.caseNumber,
        userId,
        userEmail: user?.email || '',
        userName: user?.name || userId,
        userQuery: firstUserMsg?.content || '',
        chatHistory: historyText,
        messages: supportCase.messages.map((m) => ({
          role: m.role as 'USER' | 'AGENT' | 'SYSTEM',
          content: m.content,
          createdAt: m.createdAt?.toString(),
        })),
        issue: 'Manually escalated by user',
        possibleSolution: 'User requested human assistance',
        workspaceName: supportCase.workspace?.name,
      });
      await supportCaseService.markEmailSent(caseId);
    } catch (emailErr) {
      console.error('[Support] Escalation email failed:', emailErr);
    }

    const updated = await supportCaseService.getCaseById(caseId, userId);
    res.json(updated);
  } catch (err: any) {
    if (err?.status === 403) return res.status(403).json({ error: 'Forbidden' });
    console.error('[Support] POST /cases/:caseId/escalate failed:', err);
    res.status(500).json({ error: 'Failed to escalate case' });
  }
});

// POST /api/support/cases/:caseId/close — close a case
router.post('/cases/:caseId/close', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { caseId } = req.params;

    const supportCase = await supportCaseService.getCaseById(caseId, userId);
    if (!supportCase) return res.status(404).json({ error: 'Case not found' });

    await supportCaseService.closeCase(caseId);
    res.json({ success: true });
  } catch (err: any) {
    if (err?.status === 403) return res.status(403).json({ error: 'Forbidden' });
    console.error('[Support] POST /cases/:caseId/close failed:', err);
    res.status(500).json({ error: 'Failed to close case' });
  }
});

// POST /api/support/cases/:caseId/rate — rate a case
router.post('/cases/:caseId/rate', async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { caseId } = req.params;
    const { rating } = req.body as { rating: 1 | -1 };

    if (rating !== 1 && rating !== -1) {
      return res.status(400).json({ error: 'rating must be 1 or -1' });
    }

    const supportCase = await supportCaseService.getCaseById(caseId, userId);
    if (!supportCase) return res.status(404).json({ error: 'Case not found' });

    await supportCaseService.rateCase(caseId, rating);
    res.json({ success: true });
  } catch (err: any) {
    if (err?.status === 403) return res.status(403).json({ error: 'Forbidden' });
    console.error('[Support] POST /cases/:caseId/rate failed:', err);
    res.status(500).json({ error: 'Failed to rate case' });
  }
});

export default router;
