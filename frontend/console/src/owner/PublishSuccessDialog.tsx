// S6-FE-14: success pop-up shown once the API confirms the menu is published. It replaces the old
// S11 confirmation screen and returns the owner to the dashboard. It talks only about publication,
// never verification: verification is the team's check of the details, publication is the owner's
// choice to show the menu to diners.
import { useEffect, useRef } from 'react';
import { Button } from '../ui';
import { Icon } from './icons';

export interface PublishSuccessDialogProps {
  restaurantName: string;
  /** Closes the pop-up and returns to the dashboard. */
  onClose: () => void;
}

export function PublishSuccessDialog({ restaurantName, onClose }: PublishSuccessDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  const returnToDashboard = () => {
    const dialog = ref.current;
    dialog?.close();
    onClose();
    // Publication removes the opener; return focus to the stable dashboard instead.
    dialog?.ownerDocument.getElementById('owner-content')?.focus();
  };

  useEffect(() => {
    const dialog = ref.current;
    // showModal() traps focus and makes the page behind inert; jsdom and old browsers lack it.
    if (dialog && !dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="owner-dialog"
      aria-labelledby="owner-dialog-title"
      aria-describedby="owner-dialog-text"
      onCancel={(event) => {
        // Escape closes the pop-up the same way as the button.
        event.preventDefault();
        returnToDashboard();
      }}
    >
      <span className="owner-dialog__tile">
        <Icon name="check" size={24} />
      </span>
      <h2 id="owner-dialog-title">Your menu is published</h2>
      <p id="owner-dialog-text">
        Diners can now see the {restaurantName} menu on PeekaPlate. Your dashboard pages are open,
        and reports appear once diners start using the menu.
      </p>
      <Button variant="action" className="owner-button" autoFocus onClick={returnToDashboard}>
        Go to dashboard
      </Button>
    </dialog>
  );
}
