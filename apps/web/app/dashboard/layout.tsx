import { redirect } from 'next/navigation';
import { isDashboardAuthenticated } from '@/lib/dashboard-auth';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isDashboardAuthenticated())) {
    redirect('/login');
  }

  return <>{children}</>;
}
