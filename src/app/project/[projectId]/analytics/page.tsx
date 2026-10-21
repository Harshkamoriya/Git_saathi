import RepoInsights from "./analytics";

export default async function Analytics({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <RepoInsights projectId={projectId} />;
}
