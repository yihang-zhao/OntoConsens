import { useState } from "react";
import { useParams, Link } from "wouter";
import { 
  useGetProject, 
  useSetReady, 
  useExportProject, 
  useGetMe,
  useListProperties,
  useAgreeProperty,
  useRetractProperty,
  useCreateProperty,
  useUpdateProperty,
  getGetProjectQueryKey,
  getListPropertiesQueryKey,
  getExportProjectQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { GraphCanvas } from "@/components/GraphCanvas";
import { Input } from "@/components/ui/input";
import { 
  Copy, 
  Check, 
  Download, 
  ChevronLeft, 
  Loader2, 
  Network, 
  ThumbsUp, 
  Trash2,
  ListTodo,
  CheckCircle2,
  Plus
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function PropertyList({ projectId, projectClasses, currentUserId }: { projectId: number, projectClasses: any[], currentUserId?: number }) {
  const { data: properties, isLoading } = useListProperties(projectId);
  const agreeProperty = useAgreeProperty();
  const retractProperty = useRetractProperty();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  if (isLoading) {
    return (
      <div className="flex justify-center p-4">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!properties?.length) {
    return (
      <div className="text-center p-4 text-sm text-muted-foreground">
        No properties proposed yet.
      </div>
    );
  }

  const handleAgree = (propId: number) => {
    agreeProperty.mutate({ id: projectId, propertyId: propId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey(projectId) });
        toast({ title: "Agreed to property" });
      },
      onError: (err: any) => toast({ title: "Failed to agree", description: err.error, variant: "destructive" })
    });
  };

  const handleRetract = (propId: number) => {
    retractProperty.mutate({ id: projectId, propertyId: propId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey(projectId) });
        toast({ title: "Property retracted" });
      },
      onError: (err: any) => toast({ title: "Failed to retract", description: err.error, variant: "destructive" })
    });
  };

  const pending = properties.filter(p => !p.agreedByAll);
  const agreed = properties.filter(p => p.agreedByAll);

  const renderProp = (p: any) => {
    const className = projectClasses.find(c => c.id === p.classId)?.label || `Class ${p.classId}`;
    const iHaveAgreed = p.agreements.some((a: any) => a.userId === currentUserId);
    const iProposed = p.proposedByUserId === currentUserId;

    return (
      <div key={p.id} className="border border-border/50 bg-card rounded-md p-3 mb-3 shadow-sm hover:border-border transition-colors">
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="font-semibold text-sm leading-tight text-foreground">{p.name}</div>
            <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{className}</div>
          </div>
          {p.agreedByAll && (
            <div className="bg-green-500/10 text-green-600 p-1 rounded-full">
              <CheckCircle2 className="w-4 h-4" />
            </div>
          )}
        </div>
        
        <div className="flex items-center justify-between mt-3">
          <div className="flex items-center gap-1.5">
            {/* Proposer */}
            <Tooltip>
              <TooltipTrigger>
                <div 
                  className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shadow-sm ring-1 ring-card"
                  style={{ backgroundColor: `hsl(var(--member-${p.proposedByColorSlot}))` }}
                >
                  {p.proposedByUsername.substring(0, 1).toUpperCase()}
                </div>
              </TooltipTrigger>
              <TooltipContent>Proposed by {p.proposedByUsername}</TooltipContent>
            </Tooltip>
            
            <div className="w-px h-3 bg-border mx-1" />

            {/* Agreements */}
            <div className="flex -space-x-1">
              {p.agreements.map((a: any) => (
                <Tooltip key={a.userId}>
                  <TooltipTrigger>
                    <div 
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shadow-sm ring-1 ring-card"
                      style={{ backgroundColor: `hsl(var(--member-${a.colorSlot}))` }}
                    >
                      {a.username.substring(0, 1).toUpperCase()}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>Agreed by {a.username}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {!p.agreedByAll && !iHaveAgreed && (
              <Button 
                size="sm" 
                variant="outline" 
                className="h-7 text-xs px-2 bg-green-50 hover:bg-green-100 hover:text-green-700 text-green-600 border-green-200"
                onClick={() => handleAgree(p.id)}
                disabled={agreeProperty.isPending}
              >
                <ThumbsUp className="w-3 h-3 mr-1" /> Agree
              </Button>
            )}
            {iProposed && !p.agreedByAll && (
              <Button 
                size="sm" 
                variant="ghost" 
                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => handleRetract(p.id)}
                disabled={retractProperty.isPending}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b bg-muted/20 sticky top-0 z-10 flex items-center gap-2">
        <ListTodo className="w-4 h-4 text-muted-foreground" />
        <h3 className="font-semibold text-sm">Consensus Items</h3>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {pending.length > 0 && (
          <div className="mb-6">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Pending</h4>
            {pending.map(renderProp)}
          </div>
        )}
        {agreed.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Agreed</h4>
            {agreed.map(renderProp)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProjectWorkspace() {
  const { id: idStr } = useParams();
  const projectId = parseInt(idStr || "0", 10);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: me } = useGetMe();
  const { data: project, isLoading, error } = useGetProject(projectId);
  
  const setReady = useSetReady();
  const exportQuery = useExportProject(projectId, { 
    query: { enabled: false, queryKey: getExportProjectQueryKey(projectId) } 
  });
  
  const meMember = project?.members.find(m => m.userId === me?.id);
  const isReady = meMember?.ready || false;

  const handleCopyInvite = () => {
    if (project?.inviteCode) {
      navigator.clipboard.writeText(project.inviteCode);
      toast({ title: "Invite code copied to clipboard!" });
    }
  };

  const handleToggleReady = () => {
    setReady.mutate(
      { id: projectId, data: { ready: !isReady } },
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
            title: !isReady ? "You are now marked as ready" : "You are no longer marked as ready",
            description: "Consensus state updated."
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
            {project.members.map(member => (
              <Tooltip key={member.userId}>
                <TooltipTrigger asChild>
                  <div className="relative group">
                    <Avatar 
                      className={`w-8 h-8 border-2 transition-transform duration-200 ${member.ready ? 'scale-105 border-green-500 ring-2 ring-green-500/20' : 'border-transparent'}`}
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
                  {member.ready ? " - Ready for consensus" : " - Engineering..."}
                </TooltipContent>
              </Tooltip>
            ))}
            
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

          {/* Ready Toggle */}
          <Button 
            variant={isReady ? "default" : "outline"}
            className={`min-w-[140px] shadow-sm transition-all duration-300 ${isReady ? 'bg-green-600 hover:bg-green-700 text-white' : ''}`}
            onClick={handleToggleReady}
            disabled={setReady.isPending}
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
        {/* Canvas Area (Left 75%) */}
        <main className="flex-1 min-w-0 bg-muted/10 relative">
          {me && <GraphCanvas projectId={projectId} currentUserId={me.id} />}
        </main>

        {/* Sidebar (Right 25%) */}
        <aside className="w-80 border-l bg-card shrink-0 flex flex-col shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.03)] z-10">
          <PropertyList 
            projectId={projectId} 
            projectClasses={project.classes} 
            currentUserId={me?.id} 
          />
        </aside>
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
