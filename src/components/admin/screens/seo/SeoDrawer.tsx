import Drawer from '@/components/admin/kit/Drawer';
import SeoPanel, { type SeoPanelProps } from './SeoPanel';

// "SEO: <page>" (Admin v2 U10, the prototype's seoDrawer): SeoPanel in the kit's drawer, wide
// enough for the two previews. Not dismissed by a press on the scrim (a form: a stray press
// keeps its input); Escape and Close still close it, and focus goes back to the row's
// "Edit SEO" button (the kit's useDialog). Mounted only while a page is open, so each opening
// loads that page's row afresh.

export interface SeoDrawerProps extends SeoPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function SeoDrawer({ open, onClose, ...panel }: SeoDrawerProps) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`SEO: ${panel.target.label}`}
      size="wide"
      dismissible={false}
    >
      {open && <SeoPanel key={`${panel.target.entityType}:${panel.target.entityId}`} {...panel} />}
    </Drawer>
  );
}
