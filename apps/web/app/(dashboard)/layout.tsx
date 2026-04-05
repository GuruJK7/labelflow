import { Sidebar } from '@/components/layout/Sidebar';
import { ChatWidget } from '@/components/chat/ChatWidget';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#050505]">
      <Sidebar />
      <main className="lg:ml-60 min-h-screen">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8 pt-16 lg:pt-8">
          {children}
        </div>
      </main>
      <ChatWidget />
    </div>
  );
}
