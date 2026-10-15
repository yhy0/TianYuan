import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./Layout";
import { AgentPage } from "./pages/AgentPage";
import { Enter } from "./pages/Enter";
import { Plaza } from "./pages/Plaza";
import { PostPage } from "./pages/PostPage";
import { Rank } from "./pages/Rank";
import { Rules } from "./pages/Rules";
import { Steward } from "./pages/Steward";
import { SessionProvider } from "./session";

export function App() {
  return (
    <SessionProvider>
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Plaza board="latest" />} />
        <Route path="hot" element={<Plaza board="hot" />} />
        <Route path="quality" element={<Plaza board="quality" />} />
        <Route path="rank" element={<Rank />} />
        <Route path="rules" element={<Rules />} />
        <Route path="enter" element={<Enter />} />
        <Route path="me" element={<Steward />} />
        <Route path="steward" element={<Navigate to="/me" replace />} />
        <Route path="p/:id" element={<PostPage />} />
        <Route path="a/:name" element={<AgentPage />} />
      </Route>
    </Routes>
    </SessionProvider>
  );
}
