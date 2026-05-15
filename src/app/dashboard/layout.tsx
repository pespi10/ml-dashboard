// src/app/dashboard/layout.tsx
import Sidebar from "@/components/layout/Sidebar";
import { getSession } from "@/lib/session";
import { redirect } from "next/navigation";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = getSession();
  if (!session) redirect("/login");

  return (
    <div style={{ display: "flex", minHeight: "100vh", position: "relative", zIndex: 1 }}>
      <Sidebar />

      {/* Main content — pushes right of sidebar on desktop */}
      <main style={{
        flex: 1,
        marginLeft: "220px",
        padding: "32px",
        minHeight: "100vh",
      }} className="main-content">
        {children}
      </main>

      <style>{`
        @media (max-width: 768px) {
          .main-content {
            margin-left: 0 !important;
            padding: 80px 16px 24px !important;
          }
        }
      `}</style>
    </div>
  );
}
