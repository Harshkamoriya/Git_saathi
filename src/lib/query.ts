"use server";

import { prisma } from "./db";
import { getAuthSession } from "./auth";
import { checkCreditsAndStructure, RepoGenerateEmbeddings } from "./githubLoader";
import { redirect } from "next/navigation";


export async function CreateProject(githubUrl: string, name: string) {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!session) redirect("/login");

  if (!userId) throw new Error("Unauthorized");
  if (!name?.trim()) throw new Error("Project name is required");

  // Credit check before any DB writes
  const { fileCount, userCredits } = await checkCreditsAndStructure(githubUrl);
  if (fileCount > userCredits) {
    throw new Error("Insufficient credits");
  }

  // Create project + membership first so a later indexing failure does not
  // leave the UI saying "failed" while the project already exists.
  const project = await prisma.project.create({
    data: {
      name: name.trim(),
      githubUrl,
      indexingStatus: "INDEXING",
    },
  });

  await prisma.userToProject.create({
    data: {
      userId,
      projectId: project.id,
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { credits: { decrement: fileCount } },
  });

  try {
    await RepoGenerateEmbeddings(project.id);
    await prisma.project.update({
      where: { id: project.id },
      data: { indexingStatus: "COMPLETED" },
    });
    return {
      project: { ...project, indexingStatus: "COMPLETED" },
      message: "Project created and indexed successfully",
      indexingFailed: false,
    };
  } catch (error) {
    console.error("Project created but indexing failed:", error);
    await prisma.project.update({
      where: { id: project.id },
      data: { indexingStatus: "FAILED" },
    });
    // Still return success — project exists and user can open / reindex it
    return {
      project: { ...project, indexingStatus: "FAILED" },
      message:
        "Project created, but indexing failed. Open the project and reindex from Ask me.",
      indexingFailed: true,
      indexingError: (error as Error).message,
    };
  }
}

export async function GetProjects() {
  const session = await getAuthSession();
  const userId = session?.user?.id;

  if (!userId) throw new Error("Unauthorized");

  try {
    const projects = await prisma.project.findMany({
      where: { 
        users: { some: { id: userId } },
       },
    });

    return projects;
  } catch (error) {
    console.error("Error fetching projects:", error);
    throw new Error(`Failed to fetch projects: ${(error as Error).message}`);
  } finally {
    await prisma.$disconnect();
  }
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
  } finally {
    await prisma.$disconnect();
  }
  
}

export async function GetProjectById(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      users: {
        include: {
          user: true,
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
interface UserToProject {
  project: {
    id: string;
    name: string;
    githubUrl: string | null;
  };
}

export async function GetAllProject() {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!session) redirect("/login");

  try {
    const projects: UserToProject[] = await prisma.userToProject.findMany({
      where: { userId: userId as string },
      include: {
        project: true, // Fetch project details
      },
    });

    console.log("Fetched projects:", projects);

    return projects.map((userToProject: { project: any }) => userToProject.project);
  } catch (error) {
    console.error("Error fetching projects:", error);
    throw new Error("Failed to fetch projects");
  }
}


export async function GetAllProjects() {
  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!session) redirect("/login");

  try {
    const projects = await prisma.userToProject.findMany({
      where: { userId: userId as string },
      orderBy: { createdAt: "desc" },
      include: {
        project: {
          include: {
            commits: true,
            meetings: true,
            users: true // This will include all users associated with the project
          }
        }
      },
    });
    console.log("Fetched projects:", projects);
    return projects.map((userToProject: { project: any }) => userToProject.project);
  } catch (error) {
    console.error("Error fetching projects:", error);
    throw new Error("Failed to fetch projects");
  }
}


export async function JoinProject(projectId: string ) {
  const session = await getAuthSession();
  if (!session) redirect("/login");
  try {   
    const project = await prisma.project.findUnique({
      where: { id: projectId },
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
  } finally {
    await prisma.$disconnect();
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
  } finally {
    await prisma.$disconnect();
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
  } finally {
    await prisma.$disconnect();
  }
}