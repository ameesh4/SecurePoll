import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AdminLayout from "./components/AdminLayout";
import RequireAuth from "./components/RequireAuth";
import { AuthProvider } from "./auth/AuthContext";
import RegisterPage from "./pages/RegisterPage";
import VotePage from "./pages/VotePage";
import ReplaceKeyPage from "./pages/ReplaceKeyPage";
import VoterStatusPage from "./pages/VoterStatusPage";
import AdminsPage from "./pages/admin/AdminsPage";
import AuditPage from "./pages/admin/AuditPage";
import BallotAccessPage from "./pages/admin/BallotAccessPage";
import CandidatesPage from "./pages/admin/CandidatesPage";
import DashboardPage from "./pages/admin/DashboardPage";
import ElectionDetailPage from "./pages/admin/ElectionDetailPage";
import ElectionsPage, { NewElectionPage } from "./pages/admin/ElectionsPage";
import GroupsPage from "./pages/admin/GroupsPage";
import KeyRotationsPage from "./pages/admin/KeyRotationsPage";
import LoginPage from "./pages/admin/LoginPage";
import MonitoringPage from "./pages/admin/MonitoringPage";
import QueuePage from "./pages/admin/QueuePage";
import VotersPage from "./pages/admin/VotersPage";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/register" replace />} />
          <Route path="/register" element={<RegisterPage />} />
          {/* Path fixed by the ballot-access email: ${VOTER_APP_BASE_URL}/ballot?access=<token> */}
          <Route path="/ballot" element={<VotePage />} />
          {/* Reached from the link in the voter's confirmation email. */}
          <Route path="/status/:id" element={<VoterStatusPage />} />
          {/* Reached from the status page when a voter has lost their key file. */}
          <Route path="/status/:id/new-key" element={<ReplaceKeyPage />} />
          <Route path="/admin/login" element={<LoginPage />} />

          <Route
            path="/admin"
            element={
              <RequireAuth>
                <AdminLayout />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="registrations" element={<QueuePage />} />
            {/* The old standalone detail route now selects a record inside the split pane. */}
            <Route
              path="registrations/:id"
              element={<Navigate to="/admin/registrations" replace />}
            />
            <Route path="elections" element={<ElectionsPage />} />
            <Route path="elections/new" element={<NewElectionPage />} />
            <Route path="elections/:id" element={<ElectionDetailPage />} />
            <Route
              path="elections/:id/candidates"
              element={<CandidatesPage />}
            />
            <Route path="elections/:id/voters" element={<VotersPage />} />
            <Route path="elections/:id/groups" element={<GroupsPage />} />
            <Route
              path="elections/:id/ballot-access"
              element={<BallotAccessPage />}
            />
            <Route
              path="elections/:id/monitoring"
              element={<MonitoringPage />}
            />
            <Route path="key-replacements" element={<KeyRotationsPage />} />
            <Route path="audit" element={<AuditPage />} />
            {/* Super-admin only; the router refuses reviewers regardless of the hidden nav item. */}
            <Route path="operators" element={<AdminsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/register" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
