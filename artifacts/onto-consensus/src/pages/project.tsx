import { useParams, Link } from "wouter";
import { 
  useGetProject, 
  useSetReady, 
  useExportProject, 
  useGetMe,
  getGetProjectQueryKey,
  getListPropertiesQueryKey,
  getExportProjectQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GraphCanvas } from "@/components/GraphCanvas";
import { 
  Copy, 
  Check, 
  Download, 
  ChevronLeft, 
  Loader2, 
  Network, 
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useProjectSocket } from "@/hooks/useProjectSocket";

export default function ProjectWorkspace() {
  const { id: idStr } = useParams();
  const projectId = parseInt(idStr || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: me } = useGetMe();
  // The WebSocket push is the primary sync mechanism, but a slow background
  // poll runs alongside it as a safety net: if a socket message is ever
  // dropped (or a reconnect races a broadcast), this guarantees everyone
  // converges on the same state within seconds without needing to refresh.
  const { data: project, isLoading, error } = useGetProject(projectId, {
    query: { queryKey: getGetProjectQueryKey(projectId), refetchInterval: 10_000 },
  });
  
  const setReady = useSetReady();
  const exportQuery = useExportProject(projectId, { 
    query: { enabled: false, queryKey: getExportProjectQueryKey(projectId) } 
  });
  
  const meMember = project?.members.find(m => m.userId === me?.id);
  const isReady = meMember?.ready || false;
  const allReady = Boolean(project && project.members.length > 0 && project.members.every(m => m.ready));

  // A single socket connection per project page: it stays open the whole time
  // a member is in the workspace (not just once they're ready) so that ready
  // status, joins, and property changes all show up live for everyone without
  // needing a page refresh.
  const { cursors, sendCursor, status: syncStatus, onlineUserIds } = useProjectSocket({
    projectId,
    enabled: Boolean(project && meMember),
    onProjectChanged: () => queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) }),
    onPropertiesChanged: () => queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey(projectId) }),
  });

  const handleCopyInvite = () => {
    if (project?.inviteCode) {
      navigator.clipboard.writeText(project.inviteCode);
      toast({ title: "Invite code copied to clipboard!" });
    }
  };

  const handleMarkReady = () => {
    if (isReady) return;
    setReady.mutate(
      { id: projectId, data: { ready: true } },
      {
        onSuccess: (updatedMember) => {
          queryClient.setQueryData(getGetProjectQueryKey(projectId), (old: any) => {
            if (!old) return old;
            return {
              ...old,
              members: old.members.map((m: any) => 
                m.userId === updatedMember.userId ? updatedMember : m
              )
            };
          });
          toast({ 
            title: "You are marked as ready",
            description: "Once everyone is ready, the shared consensus space opens automatically."
          });
        },
        onError: (err: any) => {
          toast({ title: "Failed to update ready state", description: err.error, variant: "destructive" });
        }
      }
    );
  };

  const handleExport = async () => {
    try {
      const { data } = await exportQuery.refetch();
      if (data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `ontology-export-${project?.name.replace(/\s+/g, '-').toLowerCase() || 'project'}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast({ title: "Export downloaded successfully" });
      }
    } catch (e) {
      toast({ title: "Export failed", variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 text-center">
        <Network className="w-12 h-12 text-muted-foreground mb-4" />
        <h2 className="text-xl font-bold mb-2">Project not found</h2>
        <p className="text-muted-foreground mb-6 max-w-md">
          The project you're looking for doesn't exist or you don't have access to it.
        </p>
        <Button asChild>
          <Link href="/">Back to Dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[100dvh] bg-background overflow-hidden">
      {/* Top Bar */}
      <header className="flex items-center justify-between h-14 px-4 border-b bg-card shrink-0 shadow-sm z-10 relative">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" asChild className="shrink-0 -ml-2">
            <Link href="/">
              <ChevronLeft className="w-5 h-5" />
            </Link>
          </Button>
          <div className="flex flex-col">
            <h1 className="font-semibold text-sm leading-tight">{project.name}</h1>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors group" onClick={handleCopyInvite}>
                Code: <span className="font-mono bg-muted px-1 rounded">{project.inviteCode}</span>
                <Copy className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6">
          {/* Member Chips */}
          <div className="flex items-center gap-2 bg-muted/50 p-1.5 rounded-full border">
            {project.members.map(member => {
              // The green ring means "in this project right now" (has an open
              // socket connection) — independent of readiness, so someone can
              // be ready but not currently present, or present but not ready.
              const isOnline = onlineUserIds.has(member.userId);
              return (
                <Tooltip key={member.userId}>
                  <TooltipTrigger asChild>
                    <div className="relative group">
                      <Avatar 
                        className={`w-8 h-8 border-2 transition-transform duration-200 ${isOnline ? 'scale-105 border-green-500 ring-2 ring-green-500/20' : 'border-transparent'}`}
                      >
                        <AvatarFallback 
                          className="text-white text-xs font-semibold shadow-inner"
                          style={{ backgroundColor: `hsl(var(--member-${member.colorSlot}))` }}
                        >
                          {member.username.substring(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {member.ready && (
                        <div className="absolute -bottom-1 -right-1 bg-green-500 text-white rounded-full p-0.5 border-2 border-card">
                          <Check className="w-2.5 h-2.5" />
                        </div>
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="font-medium text-xs">
                    {member.username} {member.userId === me?.id ? "(You)" : ""}
                    {" · "}{isOnline ? "In project" : "Not in project"}
                    {member.ready ? " · Ready" : " · Not ready"}
                  </TooltipContent>
                </Tooltip>
              );
            })}
            
            {/* Empty slots placeholders */}
            {Array.from({ length: project.maxMembers - project.members.length }).map((_, i) => (
              <div 
                key={`empty-${i}`} 
                className="w-8 h-8 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center"
              >
                <span className="text-[10px] text-muted-foreground/50 font-medium">--</span>
              </div>
            ))}
          </div>

          {/* Ready Toggle - one-way: once ready you cannot mark yourself unready */}
          <Button 
            variant={isReady ? "default" : "outline"}
            className={`min-w-[140px] shadow-sm transition-all duration-300 ${isReady ? 'bg-green-600 hover:bg-green-700 text-white cursor-default opacity-100' : ''}`}
            onClick={handleMarkReady}
            disabled={setReady.isPending || isReady}
          >
            {isReady ? (
              <>
                <Check className="w-4 h-4 mr-2" />
                Ready
              </>
            ) : (
              "Mark as Ready"
            )}
          </Button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Canvas Area (full width - the item list sidebar has been removed) */}
        <main className="flex-1 min-w-0 bg-muted/10 relative">
          {me && (
            <GraphCanvas
              projectId={projectId}
              currentUserId={me.id}
              cursors={cursors}
              sendCursor={sendCursor}
              sharedModeEnabled={allReady}
            />
          )}

          {/* Sync status - plain text floating on the workspace, no bar/box */}
          <span
            className={`pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-30 text-xs font-semibold tracking-wide ${
              syncStatus === "connected"
                ? "text-green-600 dark:text-green-400"
                : syncStatus === "reconnecting"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-destructive"
            }`}
          >
            {syncStatus === "connected" ? "Live" : syncStatus === "reconnecting" ? "Reconnecting" : "Disconnected"}
          </span>
        </main>
      </div>

      {/* Bottom Export Bar */}
      <footer className="h-16 shrink-0 bg-card border-t flex items-center justify-between px-6 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-20">
        <div className="flex flex-col">
          <span className="text-sm font-medium">Consensus Export</span>
          <span className="text-xs text-muted-foreground">Download the fully agreed ontology properties</span>
        </div>
        <Button 
          onClick={handleExport} 
          disabled={exportQuery.isFetching}
          className="gap-2 bg-foreground text-background hover:bg-foreground/90 shadow-md"
        >
          {exportQuery.isFetching ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          Export JSON
        </Button>
      </footer>
    </div>
  );
}
