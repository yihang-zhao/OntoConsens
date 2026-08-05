import * as React from "react"
import { useToast as useToastHook } from "@/components/ui/toast"

export function useToast() {
  const { toast, dismiss, toasts } = useToastHook()
  return { toast, dismiss, toasts }
}
