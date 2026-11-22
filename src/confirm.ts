import { App, Modal } from "obsidian";

/** A yes/no question. Enter confirms, Esc cancels. Resolves to the answer. */
export function confirm(app: App, title: string, body: string, confirmText: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new (class extends Modal {
			onOpen() {
				this.modalEl.addClass("pnr-confirm");
				this.titleEl.setText(title);
				this.contentEl.createEl("p", { text: body });
				const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
				const yes = buttons.createEl("button", { text: confirmText, cls: "mod-cta" });
				const no = buttons.createEl("button", { text: "Cancel" });
				yes.addEventListener("click", () => this.answer(true));
				no.addEventListener("click", () => this.answer(false));
				this.scope.register([], "Enter", (evt) => {
					// A held-down Enter must not confirm by key repeat.
					if (!evt.repeat) this.answer(true);
					return false;
				});
				window.setTimeout(() => yes.focus(), 0);
			}
			answer(v: boolean) {
				answered = true;
				resolve(v);
				this.close();
			}
			onClose() {
				if (!answered) resolve(false);
			}
		})(app);
		modal.open();
	});
}
