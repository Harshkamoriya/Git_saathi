"use server";

import { prisma } from "./db";
import { getAuthSession } from "./auth";
import { checkCreditsAndStructure } from "./githubLoader";
import { runIndexing } from "./indexing";
import { redirect } from "next/navigation";
import { after } from "next/server";

type CreateProjectResult =
  | { ok: true; project: { id: string; name: string; githubUrl: string | null; indexingStatus: string }; fileCount: number }
  | { ok: false; error: string };

const MAX_PROJECT_NAME = 80;


export async function CreateProject(githubUrl: string, name: string): Promise<CreateProjectResult> {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Please sign in again." };

  const projectName = name?.trim() ?? "";
  if (!projectName) return { ok: false, error: "Project name is required." };
  if (projectName.length > MAX_PROJECT_NAME) {
    return { ok: false, error: `Project name must be ${MAX_PROJECT_NAME} characters or fewer.` };
  }

  // Recount on the server; never trust a count sent from the browser
  const check = await checkCreditsAndStructure(githubUrl);
  if (!check.ok) return check;
  if (check.alreadyAdded) return { ok: false, error: "You've already added this repository as a project." };

  const { fileCount } = check;

  let project: { id: string; name: string; githubUrl: string | null; indexingStatus: string };
  try {
    project = await prisma.$transaction(async (tx) => {
      // Conditional decrement so two tabs can't both spend the same credits
      const charged = await tx.user.updateMany({
        where: { id: userId, credits: { gte: fileCount } },
        data: { credits: { decrement: fileCount } },
      });
      if (charged.count === 0) throw new Error("INSUFFICIENT_CREDITS");

      return tx.project.create({
        data: {
          name: projectName,
          githubUrl: check.githubUrl,
          indexingStatus: "INDEXING",
          users: { create: { userId } },
        },
        select: { id: true, name: true, githubUrl: true, indexingStatus: true },
      });
    });
  } catch (error) {
    if ((error as Error).message === "INSUFFICIENT_CREDITS") {
      return {
        ok: false,
        error: `This repo needs ${fileCount} credits and you have ${check.userCredits}.`,
      };
    }
    console.error("CreateProject failed:", error);
    return { ok: false, error: "Couldn't create the project. Please try again." };
  }

  // Index after the response is sent, so the user isn't stuck waiting on the create screen
  after(() => runIndexing(project.id, { userId, credits: fileCount }));

  return { ok: true, project, fileCount };
}

export async function getCommit(projectId:string) {
  // const session = await getAuthSession();
  // const userId = session?.user?.id;

  // if (!userId) throw new Error("Unauthorized");

  try {
    const commits = await prisma.commit.findMany({
      where: { projectId: projectId },
      orderBy: { commitDate: "desc" },
    });

    return commits;
  } catch (error) {
    console.error("Error fetching commits:", error);
    throw new Error(`Failed to fetch commits: ${(error as Error).message}`);
  }
  
}

export async function GetProjectById(projectId: string) {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Please sign in again.");

  // Membership is part of the filter, so other users' projects look the same as missing ones
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null, users: { some: { userId } } },
    include: {
      users: {
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          user: { select: { id: true, name: true, image: true } },
        },
      },
    },
  });

  if (!project) {
    throw new Error("Project not found");
  }

  return project;
}

export async function getCommits(projectId: string) {
  const commits = await prisma.commit.findMany({
    where: { projectId },
    orderBy: { commitDate: "desc" },
    take: 10,
  });

  return commits;
}
export interface ProjectSummary {
  id: string;
  name: string;
  githubUrl: string | null;
  indexingStatus: string;
  createdAt: Date;
  updatedAt: Date;
  joinedAt: Date;
  isOwner: boolean;
  counts: { commits: number; meetings: number; members: number };
}

// There is no owner column; the first member (the creator) is treated as the owner
async function getOwnerId(projectId: string) {
  const first = await prisma.userToProject.findFirst({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  return first?.userId ?? null;
}

export async function GetAllProjects(): Promise<ProjectSummary[]> {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const memberships = await prisma.userToProject.findMany({
    where: { userId, project: { deletedAt: null } },
    orderBy: { project: { updatedAt: "desc" } },
    select: {
      createdAt: true,
      project: {
        select: {
          id: true,
          name: true,
          githubUrl: true,
          indexingStatus: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { commits: true, meetings: true, users: true } },
          users: { orderBy: { createdAt: "asc" }, take: 1, select: { userId: true } },
        },
      },
    },
  });

  return memberships.map(({ createdAt, project }) => ({
    id: project.id,
    name: project.name,
    githubUrl: project.githubUrl,
    indexingStatus: project.indexingStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    joinedAt: createdAt,
    isOwner: project.users[0]?.userId === userId,
    counts: {
      commits: project._count.commits,
      meetings: project._count.meetings,
      members: project._count.users,
    },
  }));
}

export async function ArchiveProject(projectId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Please sign in again." };

  try {
    const ownerId = await getOwnerId(projectId);
    if (!ownerId) return { ok: false, error: "Project not found." };
    if (ownerId !== userId) return { ok: false, error: "Only the person who created this project can archive it." };

    const updated = await prisma.project.updateMany({
      where: { id: projectId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (updated.count === 0) return { ok: false, error: "Project not found." };
    return { ok: true };
  } catch (error) {
    console.error(`ArchiveProject failed for ${projectId}:`, error);
    return { ok: false, error: "Couldn't archive the project. Please try again." };
  }
}

export async function LeaveProject(projectId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "Please sign in again." };

  try {
    const ownerId = await getOwnerId(projectId);
    if (!ownerId) return { ok: false, error: "Project not found." };
    if (ownerId === userId) {
      return { ok: false, error: "You created this project. Archive it instead of leaving." };
    }

    const removed = await prisma.userToProject.deleteMany({ where: { userId, projectId } });
    if (removed.count === 0) return { ok: false, error: "You're not a member of this project." };
    return { ok: true };
  } catch (error) {
    console.error(`LeaveProject failed for ${projectId}:`, error);
    return { ok: false, error: "Couldn't leave the project. Please try again." };
  }
}


export async function JoinProject(projectId: string ) {
  const session = await getAuthSession();
  if (!session) redirect("/login");
  try {   
    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });
    if(!project) {
      throw new Error("Project not found");
    }
    const userId = session.user.id;
    const existingMembership = await prisma.userToProject.findUnique({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
    });
    if (existingMembership) {
      // throw new Error("User is already a member of this project");
      return { message: "User is already a member of this project" };
    }
    // Add the user to the project
    await prisma.userToProject.create({
      data: {
        userId,
        projectId,
      },
    });
    return { message: "User successfully added to the project" };

  }
  catch (error) {
    console.error("Error joining project:", error);
    throw new Error(`Failed to join project: ${(error as Error).message}`);
  }

}

export async function allMembers(projectId : string){
  try{
    const userToProjects = await prisma.userToProject.findMany({
      where: { projectId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });
  
    return userToProjects.map((utp : any) => ({
      id: utp.user.id,
      name: utp.user.name || "Unknown",
      image: utp.user.image || "/default-avatar.png", // Fallback image
    }));
  }
  catch (error) {
    console.error("Error fetching members:", error);
    throw new Error(`Failed to fetch members: ${(error as Error).message}`);
  }
}

export async function MeetingStatus(meetingId: string) {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { status: true },
    });

    if (!meeting) {
      throw new Error("Meeting not found");
    }

    return meeting;
  } catch (error) {
    console.error("Error fetching meeting status:", error);
    throw new Error(`Failed to fetch meeting status: ${(error as Error).message}`);
  }
}