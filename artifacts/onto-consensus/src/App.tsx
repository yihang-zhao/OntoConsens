import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ProtectedRoute } from '@/hooks/use-auth';
import { useLogout } from '@workspace/api-client-react';
import { clearAuthToken } from '@/lib/authToken';

import Login from '@/pages/login';
import Register from '@/pages/register';
import Dashboard from '@/pages/dashboard';
import ProjectWorkspace from '@/pages/project';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useQueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-background">
      <h1 className="text-4xl font-bold text-foreground font-mono mb-2">404</h1>
      <p className="text-muted-foreground mb-6">Page not found</p>
      <Button asChild>
        <a href="/">Go Home</a>
      </Button>
    </div>
  );
}

function MainShell({ children }: { children: React.ReactNode }) {
  const [, setLocation] = useLocation();
  const logout = useLogout();
  const queryClient = useQueryClient();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSettled: () => {
        clearAuthToken();
        queryClient.clear();
        setLocation("/login");
      }
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* We only show logout floating if not in a workspace that handles its own header.
          Actually, let's inject a generic logout button for the dashboard.
          Workspace handles its own full screen shell. 
      */}
      <Switch>
        <Route path="/projects/:id">
          {children}
        </Route>
        <Route path="/">
          <div className="absolute top-3 right-4 z-50">
            <Button variant="ghost" size="sm" onClick={handleLogout} className="text-muted-foreground hover:text-foreground gap-2">
              <LogOut className="w-4 h-4" />
              Sign out
            </Button>
          </div>
          {children}
        </Route>
        <Route>
          {children}
        </Route>
      </Switch>
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      
      <Route path="/">
        <ProtectedRoute>
          <MainShell>
            <Dashboard />
          </MainShell>
        </ProtectedRoute>
      </Route>
      
      <Route path="/projects/:id">
        <ProtectedRoute>
          <MainShell>
            <ProjectWorkspace />
          </MainShell>
        </ProtectedRoute>
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function ScopedToaster() {
  // The project workspace intentionally has no popup "message window" — status
  // (ready, errors) is shown inline in its own UI instead of transient toasts.
  const [location] = useLocation();
  if (location.startsWith('/projects/')) return null;
  return <Toaster />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <ScopedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
