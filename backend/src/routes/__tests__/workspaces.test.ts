import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { app } from '../../server';
import { prisma } from '../../lib/prisma';
import fetch from 'node-fetch';

// Mock the AI brain module to avoid real API calls
vi.mock('../../brain/ai', () => ({
  ai: {
    generateProjectMetadata: vi.fn(async () => ({
      name: 'test-project',
      summary: 'A test project'
    }))
  }
}));

describe('POST /api/workspaces', () => {
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = 'http://localhost:8000';
  });

  afterAll(async () => {
    // Cleanup test data
    await prisma.workspace.deleteMany({
      where: {
        userId: 'test-user-123'
      }
    });
  });

  it('should create workspace with GENERATING status initially', async () => {
    const formData = new FormData();
    formData.append('userId', 'test-user-123');
    formData.append('idea', 'A test project');
    formData.append('framework', 'Next.js');

    const res = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      body: formData
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('summary');
    expect(data).toHaveProperty('status');
    expect(data.status).toBe('READY');
    expect(data.name).not.toBe('untitled');
  });

  it('should return workspace with generated metadata', async () => {
    const formData = new FormData();
    formData.append('userId', 'test-user-456');
    formData.append('idea', 'Another test project');
    formData.append('framework', 'Next.js');

    const res = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      body: formData
    });

    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.name).toBe('test-project');
    expect(data.summary).toBe('A test project');
    expect(data.status).toBe('READY');
    expect(data.imageIds).toEqual([]);
  });

  it('should return error if metadata generation fails', async () => {
    const { ai } = await import('../../brain/ai');
    vi.mocked(ai.generateProjectMetadata).mockRejectedValueOnce(new Error('AI service unavailable'));

    const formData = new FormData();
    formData.append('userId', 'test-user-789');
    formData.append('idea', 'Failing project');
    formData.append('framework', 'Next.js');

    const res = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      body: formData
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data).toHaveProperty('error');
    expect(data).toHaveProperty('workspaceId');

    // Verify workspace is marked as FAILED
    const workspace = await prisma.workspace.findUnique({
      where: { id: data.workspaceId }
    });
    expect(workspace?.status).toBe('FAILED');

    // Restore mock
    vi.mocked(ai.generateProjectMetadata).mockResolvedValue({
      name: 'test-project',
      summary: 'A test project'
    });
  });

  it('should never return untitled in response', async () => {
    const formData = new FormData();
    formData.append('userId', 'test-user-999');
    formData.append('idea', 'Some idea');
    formData.append('framework', 'Next.js');

    const res = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      body: formData
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).not.toBe('untitled');
  });
});
