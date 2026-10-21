import PRAndIssuesClient from "./PRandIssue";

export default async function PRAndIssuesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PRAndIssuesClient projectId={projectId} />;
}
