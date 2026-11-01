import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useLang } from "@/lib/lang";

/** Everything the keyboard does, in one place. It opens with ? and from the top bar. */
export function KeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLang();
  const rows: [string[], string][] = [
    [["←", "→"], t("上一步、下一步", "Previous and next step")],
    [["1–9"], t("走这个分支", "Take that branch")],
    [["⌘K", "/"], t("搜索", "Search")],
    [["Esc"], t("关闭面板，取消追踪", "Close the panel, stop tracing")],
    [["?"], t("这份说明", "This list")],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="gap-3 rounded-md!">
        <DialogHeader>
          <DialogTitle className="text-ui font-semibold">{t("键盘操作", "Keyboard")}</DialogTitle>
          <DialogDescription className="sr-only">{t("这个页面可以用的按键", "The keys this page answers to")}</DialogDescription>
        </DialogHeader>
        <dl className="grid gap-2 text-ui">
          {rows.map(([keys, what]) => <div key={what} className="flex items-center justify-between gap-4"><dt className="text-muted-foreground">{what}</dt><dd className="flex shrink-0 items-center gap-1">{keys.map((k) => <Kbd key={k} className="font-mono">{k}</Kbd>)}</dd></div>)}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
