import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { Provider } from "@/components/ui/provider"
import Popup from "./Popup"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider>
      <Popup />
    </Provider>
  </StrictMode>,
)
