import { createSupabaseServer } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import { storageBackend } from '@/lib/api-v2-auth';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (storageBackend() !== 'supabase') {
    return (
      <main style={{ padding: '4rem', fontFamily: 'sans-serif' }}>
        <h1>Dashboard unavailable</h1>
        <p>
          The web dashboard requires the Supabase backend. This instance uses a
          different storage backend; agents connect via the REST API as usual.
        </p>
      </main>
    );
  }

  const supabase = await createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return <>{children}</>;
}
