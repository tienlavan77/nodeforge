// Route Code navigation to the existing System Engineer coding workspace.
import { redirect } from "next/navigation";

// Keep the Code entry point aligned with the workspace that handles coding conversations.
export default function CodingPage() {
  redirect("/system");
}
