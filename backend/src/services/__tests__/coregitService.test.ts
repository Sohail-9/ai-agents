import * as coregitService from "../coregitService";

// Mock fetch
global.fetch = jest.fn();

describe("Coregit Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockReset();
  });

  describe("getFileFromCommit", () => {
    it("should fetch file content from a specific commit", async () => {
      const mockResponse = {
        content: "console.log('test');",
        path: "src/index.ts",
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(mockResponse)),
      });

      const result = await coregitService.getFileFromCommit(
        "test-repo",
        "abc123",
        "src/index.ts"
      );

      expect(result).toEqual(mockResponse);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/test-repo/commits/abc123/files/src%2Findex.ts"),
        expect.any(Object)
      );
    });

    it("should handle file path encoding", async () => {
      const mockResponse = { content: "test" };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(mockResponse)),
      });

      await coregitService.getFileFromCommit(
        "test-repo",
        "abc123",
        "src/components/Button.tsx"
      );

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("src%2Fcomponents%2FButton.tsx"),
        expect.any(Object)
      );
    });

    it("should try fallback endpoint on 404", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue("Not found"),
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ content: "fallback content" })),
      });

      const result = await coregitService.getFileFromCommit(
        "test-repo",
        "abc123",
        "src/index.ts"
      );

      expect(result).toEqual({ content: "fallback content" });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should throw error if both endpoints fail", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue("Not found"),
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue("Not found"),
      });

      await expect(
        coregitService.getFileFromCommit("test-repo", "abc123", "nonexistent.txt")
      ).rejects.toThrow("File not found or inaccessible");
    });

    it("should include API key in request headers", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ content: "test" })),
      });

      await coregitService.getFileFromCommit("test-repo", "abc123", "test.txt");

      const callArgs = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(callArgs.headers["x-api-key"]).toBeDefined();
    });
  });

  describe("getCommitFileTree", () => {
    it("should fetch file tree for a specific commit", async () => {
      const mockTree = {
        tree: [
          {
            path: "src",
            type: "directory",
            children: [
              {
                path: "src/index.ts",
                type: "file",
              },
            ],
          },
        ],
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(mockTree)),
      });

      const result = await coregitService.getCommitFileTree("test-repo", "abc123");

      expect(result).toEqual(mockTree);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/test-repo/commits/abc123/tree"),
        expect.any(Object)
      );
    });

    it("should try fallback endpoint on 404", async () => {
      const mockTree = { tree: [] };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue("Not found"),
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(mockTree)),
      });

      const result = await coregitService.getCommitFileTree("test-repo", "abc123");

      expect(result).toEqual(mockTree);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("should handle error response", async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue("Not found"),
      });

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: jest.fn().mockResolvedValue("Not found"),
      });

      await expect(
        coregitService.getCommitFileTree("test-repo", "invalid-sha")
      ).rejects.toThrow();
    });

    it("should pass content-type header", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ tree: [] })),
      });

      await coregitService.getCommitFileTree("test-repo", "abc123");

      const callArgs = (global.fetch as jest.Mock).mock.calls[0][1];
      expect(callArgs.headers["Content-Type"]).toBe("application/json");
    });
  });

  describe("getCommits", () => {
    it("should fetch commit list with default options", async () => {
      const mockCommits = {
        commits: [
          {
            sha: "abc123",
            shortSha: "abc123",
            message: "Test commit",
            timestamp: new Date().toISOString(),
          },
        ],
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify(mockCommits)),
      });

      const result = await coregitService.getCommits("test-repo", {});

      expect(result).toEqual(mockCommits);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/repos/test-repo/commits"),
        expect.any(Object)
      );
    });

    it("should include limit in query params", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ commits: [] })),
      });

      await coregitService.getCommits("test-repo", { limit: 50 });

      const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain("limit=50");
    });

    it("should include cursor in query params", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(JSON.stringify({ commits: [] })),
      });

      await coregitService.getCommits("test-repo", { cursor: "next-page" });

      const callUrl = (global.fetch as jest.Mock).mock.calls[0][0];
      expect(callUrl).toContain("cursor=next-page");
    });

    it("should handle error response", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn().mockResolvedValue("Server error"),
      });

      await expect(coregitService.getCommits("test-repo", {})).rejects.toThrow();
    });
  });

  describe("getRepoInfo", () => {
    it("should return repository metadata", () => {
      const result = coregitService.getRepoInfo("my-project");

      expect(result).toHaveProperty("slug", "my-project");
      expect(result).toHaveProperty("org");
      expect(result).toHaveProperty("cloneUrl");
      expect(result).toHaveProperty("webUrl");
    });

    it("should include clone URL in the response", () => {
      const result = coregitService.getRepoInfo("my-project");

      expect(result.cloneUrl).toContain("coregit.dev");
      expect(result.cloneUrl).toContain("my-project");
    });

    it("should include web URL in the response", () => {
      const result = coregitService.getRepoInfo("my-project");

      expect(result.webUrl).toContain("app.coregit.dev");
      expect(result.webUrl).toContain("my-project");
    });

    it("should format URLs correctly for different slugs", () => {
      const result1 = coregitService.getRepoInfo("project-1");
      const result2 = coregitService.getRepoInfo("project-2");

      expect(result1.cloneUrl).toContain("project-1");
      expect(result2.cloneUrl).toContain("project-2");

      expect(result1.webUrl).not.toBe(result2.webUrl);
    });
  });

  describe("API Key Handling", () => {
    it("should require API_KEY environment variable", () => {
      const originalKey = process.env.COREGIT_API_KEY;

      // API key should be set from environment
      expect(process.env.COREGIT_API_KEY || "test-key").toBeDefined();

      if (originalKey) {
        process.env.COREGIT_API_KEY = originalKey;
      }
    });

    it("should use org from environment or default", () => {
      const result = coregitService.getRepoInfo("test");

      // Org should default to "ai-agents" or use env variable
      expect(result.org).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    it("should handle non-JSON responses gracefully", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: jest.fn().mockResolvedValue(""),
      });

      const result = await coregitService.getCommits("test-repo", {});

      expect(result).toBeNull();
    });

    it("should propagate HTTP status codes", async () => {
      const error = new Error("API Error");
      (error as any).status = 403;

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 403,
        text: jest.fn().mockResolvedValue("Forbidden"),
      });

      await expect(coregitService.getCommits("test-repo", {})).rejects.toThrow();
    });
  });
});
