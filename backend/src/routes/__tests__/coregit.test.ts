import request from "supertest";
import { Router } from "express";
import coregitRouter from "../coregit";
import * as coregitService from "../../services/coregitService";

// Mock the service
jest.mock("../../services/coregitService");

const createTestApp = () => {
  const router = Router();
  router.use("/", coregitRouter);
  return router;
};

describe("Coregit Routes", () => {
  let app: any;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
  });

  describe("GET /:slug/commits", () => {
    it("should return commits for a workspace", async () => {
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

      (coregitService.getCommits as jest.Mock).mockResolvedValue(mockCommits);

      const response = await request(app).get("/test-workspace/commits");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockCommits);
      expect(coregitService.getCommits).toHaveBeenCalledWith("test-workspace", {
        limit: 20,
        cursor: undefined,
      });
    });

    it("should accept limit and cursor parameters", async () => {
      const mockCommits = { commits: [] };
      (coregitService.getCommits as jest.Mock).mockResolvedValue(mockCommits);

      const response = await request(app)
        .get("/test-workspace/commits")
        .query({ limit: 50, cursor: "next-page" });

      expect(response.status).toBe(200);
      expect(coregitService.getCommits).toHaveBeenCalledWith("test-workspace", {
        limit: 50,
        cursor: "next-page",
      });
    });

    it("should cap limit at 100", async () => {
      const mockCommits = { commits: [] };
      (coregitService.getCommits as jest.Mock).mockResolvedValue(mockCommits);

      const response = await request(app)
        .get("/test-workspace/commits")
        .query({ limit: 500 });

      expect(coregitService.getCommits).toHaveBeenCalledWith("test-workspace", {
        limit: 100,
        cursor: undefined,
      });
    });

    it("should handle service errors", async () => {
      const error = new Error("API Error");
      (error as any).status = 500;
      (coregitService.getCommits as jest.Mock).mockRejectedValue(error);

      const response = await request(app).get("/test-workspace/commits");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("API Error");
    });

    it("should handle 404 errors appropriately", async () => {
      const error = new Error("Not found");
      (error as any).status = 404;
      (coregitService.getCommits as jest.Mock).mockRejectedValue(error);

      const response = await request(app).get("/test-workspace/commits");

      expect(response.status).toBe(404);
    });
  });

  describe("GET /:slug/commits/:sha/tree", () => {
    it("should return file tree for a commit", async () => {
      const mockTree = {
        tree: [
          {
            path: "src",
            type: "directory",
            children: [
              {
                path: "src/App.tsx",
                type: "file",
              },
            ],
          },
        ],
      };

      (coregitService.getCommitFileTree as jest.Mock).mockResolvedValue(mockTree);

      const response = await request(app).get("/test-workspace/commits/abc123/tree");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockTree);
      expect(coregitService.getCommitFileTree).toHaveBeenCalledWith(
        "test-workspace",
        "abc123"
      );
    });

    it("should handle file tree not found", async () => {
      const error = new Error("File tree not found");
      (error as any).status = 404;
      (coregitService.getCommitFileTree as jest.Mock).mockRejectedValue(error);

      const response = await request(app).get("/test-workspace/commits/abc123/tree");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("file tree");
    });

    it("should handle service errors", async () => {
      const error = new Error("Service unavailable");
      (error as any).status = 503;
      (coregitService.getCommitFileTree as jest.Mock).mockRejectedValue(error);

      const response = await request(app).get("/test-workspace/commits/abc123/tree");

      expect(response.status).toBe(503);
    });
  });

  describe("GET /:slug/commits/:sha/files/*", () => {
    it("should return file content for a specific file", async () => {
      const mockFile = {
        content: "console.log('test');",
        path: "src/index.ts",
      };

      (coregitService.getFileFromCommit as jest.Mock).mockResolvedValue(mockFile);

      const response = await request(app).get(
        "/test-workspace/commits/abc123/files/src%2Findex.ts"
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockFile);
      expect(coregitService.getFileFromCommit).toHaveBeenCalledWith(
        "test-workspace",
        "abc123",
        "src/index.ts"
      );
    });

    it("should handle encoded file paths", async () => {
      const mockFile = {
        content: "# README",
        path: "README.md",
      };

      (coregitService.getFileFromCommit as jest.Mock).mockResolvedValue(mockFile);

      const response = await request(app).get(
        "/test-workspace/commits/abc123/files/README.md"
      );

      expect(response.status).toBe(200);
      expect(coregitService.getFileFromCommit).toHaveBeenCalledWith(
        "test-workspace",
        "abc123",
        "README.md"
      );
    });

    it("should handle deep file paths", async () => {
      const mockFile = {
        content: "test content",
        path: "src/components/ui/Button.tsx",
      };

      (coregitService.getFileFromCommit as jest.Mock).mockResolvedValue(mockFile);

      const response = await request(app).get(
        "/test-workspace/commits/abc123/files/src%2Fcomponents%2Fui%2FButton.tsx"
      );

      expect(response.status).toBe(200);
      expect(coregitService.getFileFromCommit).toHaveBeenCalledWith(
        "test-workspace",
        "abc123",
        "src/components/ui/Button.tsx"
      );
    });

    it("should return 400 if file path is missing", async () => {
      const response = await request(app).get("/test-workspace/commits/abc123/files/");

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("File path is required");
    });

    it("should handle file not found", async () => {
      const error = new Error("File not found");
      (error as any).status = 404;
      (coregitService.getFileFromCommit as jest.Mock).mockRejectedValue(error);

      const response = await request(app).get(
        "/test-workspace/commits/abc123/files/nonexistent.txt"
      );

      expect(response.status).toBe(404);
    });

    it("should handle service errors", async () => {
      const error = new Error("Failed to fetch file");
      (error as any).status = 500;
      (coregitService.getFileFromCommit as jest.Mock).mockRejectedValue(error);

      const response = await request(app).get(
        "/test-workspace/commits/abc123/files/src%2Findex.ts"
      );

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Failed to fetch file");
    });
  });

  describe("GET /:slug/info", () => {
    it("should return repository info", async () => {
      const mockInfo = {
        slug: "test-workspace",
        org: "prettiflow",
        cloneUrl: "https://prettiflow:token@api.coregit.dev/prettiflow/test-workspace.git",
        webUrl: "https://app.coregit.dev/prettiflow/test-workspace",
      };

      (coregitService.getRepoInfo as jest.Mock).mockReturnValue(mockInfo);

      const response = await request(app).get("/test-workspace/info");

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockInfo);
      expect(coregitService.getRepoInfo).toHaveBeenCalledWith("test-workspace");
    });

    it("should include clone URL in response", async () => {
      const mockInfo = {
        slug: "my-project",
        org: "prettiflow",
        cloneUrl: expect.stringContaining("coregit.dev"),
        webUrl: expect.stringContaining("app.coregit.dev"),
      };

      (coregitService.getRepoInfo as jest.Mock).mockReturnValue(mockInfo);

      const response = await request(app).get("/my-project/info");

      expect(response.status).toBe(200);
      expect(response.body.cloneUrl).toContain("coregit.dev");
      expect(response.body.webUrl).toContain("app.coregit.dev");
    });
  });

  describe("Error Handling", () => {
    it("should handle errors without status property", async () => {
      const error = new Error("Unknown error");
      (coregitService.getCommits as jest.Mock).mockRejectedValue(error);

      const response = await request(app).get("/test-workspace/commits");

      expect(response.status).toBe(500);
      expect(response.body.error).toBe("Unknown error");
    });

    it("should provide default error message", async () => {
      (coregitService.getFileFromCommit as jest.Mock).mockRejectedValue(new Error());

      const response = await request(app).get(
        "/test-workspace/commits/abc123/files/test.txt"
      );

      expect(response.status).toBe(500);
      expect(response.body.error).toBeDefined();
    });
  });
});
