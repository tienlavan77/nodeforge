// Preserve the legacy /coding entry point while Code uses its canonical route.
import { redirect } from "next/navigation";

// Redirect legacy coding URLs to the canonical Code workspace.
export default function CodingPage() {
  redirect("/code");
}
