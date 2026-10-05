// Preserve /code as a compatibility alias for the established /coding route.
import { redirect } from "next/navigation";

// Redirect the short Code URL to the canonical coding workspace.
export default function CodePage() {
  redirect("/coding");
}
