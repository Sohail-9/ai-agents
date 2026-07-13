import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";

export type Skill = { name: string; description: string; filePath: string; folderName: string };

class SkillRegistrySpace {
  private skills = new Map<string, Skill>();
  private readonly skillsRoot: string;

  constructor() {
    this.skillsRoot = path.join(".", "src", "skills");
  }

  async loadSkills(): Promise<void> {
    this.skills.clear();

    const skillFiles = await this.findSkillFiles(this.skillsRoot);

    for (const filePath of skillFiles) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const parsed = matter(content);

        const name = parsed.data.name;
        const description = parsed.data.description || "";

        if (!name) {
          console.warn(`Invalid skill (missing name): ${filePath}`);
          continue;
        }

        this.skills.set(name, {
          name,
          description,
          filePath,
          folderName: path.basename(path.dirname(filePath)),
        });
      } catch (error) {
        console.error(`Failed loading skill: ${filePath}`, error);
      }
    }
  }

  findSkill(name: string): Skill | null {
    return this.skills.get(name) || null;
  }

  findSkills(query?: string): Skill[] {
    const skills = Array.from(this.skills.values());

    if (!query) return skills;

    const q = query.toLowerCase();

    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q),
    );
  }

  getAllSkills(): Skill[] {
    const AllSkill = Array.from(this.skills.values());
    return AllSkill;
  }

  async getSkillContent(name: string): Promise<string | null> {
    const skill = this.findSkill(name);
    if (!skill) return null;

    return fs.readFile(skill.filePath, "utf-8");
  }

  private async findSkillFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await this.findSkillFiles(fullPath)));
      }

      if (entry.isFile() && entry.name === "SKILL.md") {
        files.push(fullPath);
      }
    }

    return files;
  }
}

export const skillRegistry = new SkillRegistrySpace();
