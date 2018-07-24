/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as nls from 'vs/nls';
import { illegalArgument, onUnexpectedError } from 'vs/base/common/errors';
import { KeyMod, KeyCode } from 'vs/base/common/keyCodes';
import { TPromise } from 'vs/base/common/winjs.base';
import { RawContextKey, IContextKey, IContextKeyService, ContextKeyExpr } from 'vs/platform/contextkey/common/contextkey';
import { IProgressService } from 'vs/platform/progress/common/progress';
import { registerEditorAction, registerEditorContribution, ServicesAccessor, EditorAction, EditorCommand, registerEditorCommand, registerDefaultLanguageCommand } from 'vs/editor/browser/editorExtensions';
import { IEditorContribution } from 'vs/editor/common/editorCommon';
import { ITextModel } from 'vs/editor/common/model';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import RenameInputField from './renameInputField';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { asWinJsPromise } from 'vs/base/common/async';
import { WorkspaceEdit, RenameProviderRegistry, RenameProvider, RenameLocation } from 'vs/editor/common/modes';
import { Position, IPosition } from 'vs/editor/common/core/position';
import { alert } from 'vs/base/browser/ui/aria/aria';
import { Range } from 'vs/editor/common/core/range';
import { MessageController } from 'vs/editor/contrib/message/messageController';
import { EditorState, CodeEditorStateFlag } from 'vs/editor/browser/core/editorState';
import { KeybindingsRegistry } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IBulkEditService } from 'vs/editor/browser/services/bulkEditService';
import URI from 'vs/base/common/uri';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';

class RenameSkeleton {

	private _provider: RenameProvider[];

	constructor(
		readonly model: ITextModel,
		readonly position: Position
	) {
		this._provider = RenameProviderRegistry.ordered(model);
	}

	hasProvider() {
		return this._provider.length > 0;
	}

	async resolveRenameLocation(): Promise<RenameLocation> {

		let [provider] = this._provider;
		let res: RenameLocation;

		if (provider.resolveRenameLocation) {
			res = await asWinJsPromise(token => provider.resolveRenameLocation(this.model, this.position, token));
		}

		if (!res) {
			let word = this.model.getWordAtPosition(this.position);
			if (word) {
				res = {
					range: new Range(this.position.lineNumber, word.startColumn, this.position.lineNumber, word.endColumn),
					text: word.word
				};
			}
		}

		return res;
	}

	async provideRenameEdits(newName: string, i: number = 0, rejects: string[] = [], position: Position = this.position): Promise<WorkspaceEdit> {

		if (i >= this._provider.length) {
			return {
				edits: undefined,
				rejectReason: rejects.join('\n')
			};
		}

		let provider = this._provider[i];
		let result = await asWinJsPromise((token) => provider.provideRenameEdits(this.model, this.position, newName, token));
		if (!result) {
			return this.provideRenameEdits(newName, i + 1, rejects.concat(nls.localize('no result', "No result.")));
		} else if (result.rejectReason) {
			return this.provideRenameEdits(newName, i + 1, rejects.concat(result.rejectReason));
		}
		return result;
	}
}

export async function rename(model: ITextModel, position: Position, newName: string): Promise<WorkspaceEdit> {
	return new RenameSkeleton(model, position).provideRenameEdits(newName);
}

// ---  register actions and commands

const CONTEXT_RENAME_INPUT_VISIBLE = new RawContextKey<boolean>('renameInputVisible', false);

class RenameController implements IEditorContribution {

	private static readonly ID = 'editor.contrib.renameController';

	public static get(editor: ICodeEditor): RenameController {
		return editor.getContribution<RenameController>(RenameController.ID);
	}

	private _renameInputField: RenameInputField;
	private _renameInputVisible: IContextKey<boolean>;

	constructor(
		private editor: ICodeEditor,
		@INotificationService private readonly _notificationService: INotificationService,
		@IBulkEditService private readonly _bulkEditService: IBulkEditService,
		@IProgressService private readonly _progressService: IProgressService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
	) {
		this._renameInputField = new RenameInputField(editor, themeService);
		this._renameInputVisible = CONTEXT_RENAME_INPUT_VISIBLE.bindTo(contextKeyService);
	}

	public dispose(): void {
		this._renameInputField.dispose();
	}

	public getId(): string {
		return RenameController.ID;
	}

	public async run(): Promise<void> {

		const position = this.editor.getPosition();
		const skeleton = new RenameSkeleton(this.editor.getModel(), position);

		if (!skeleton.hasProvider()) {
			return undefined;
		}

		let loc: RenameLocation;
		try {
			loc = await skeleton.resolveRenameLocation();
		} catch (e) {
			MessageController.get(this.editor).showMessage(e, position);
			return undefined;
		}

		if (!loc) {
			return undefined;
		}

		let selection = this.editor.getSelection();
		let selectionStart = 0;
		let selectionEnd = loc.text.length;

		if (!Range.isEmpty(selection) && !Range.spansMultipleLines(selection) && Range.containsRange(loc.range, selection)) {
			selectionStart = Math.max(0, selection.startColumn - loc.range.startColumn);
			selectionEnd = Math.min(loc.range.endColumn, selection.endColumn) - loc.range.startColumn;
		}

		this._renameInputVisible.set(true);
		return this._renameInputField.getInput(loc.range, loc.text, selectionStart, selectionEnd).then(newNameOrFocusFlag => {
			this._renameInputVisible.reset();

			if (typeof newNameOrFocusFlag === 'boolean') {
				if (newNameOrFocusFlag) {
					this.editor.focus();
				}
				return undefined;
			}

			this.editor.focus();

			const state = new EditorState(this.editor, CodeEditorStateFlag.Position | CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection | CodeEditorStateFlag.Scroll);

			const renameOperation = TPromise.wrap(skeleton.provideRenameEdits(newNameOrFocusFlag, 0, [], Range.lift(loc.range).getStartPosition()).then(result => {
				if (result.rejectReason) {
					if (state.validate(this.editor)) {
						MessageController.get(this.editor).showMessage(result.rejectReason, this.editor.getPosition());
					} else {
						this._notificationService.info(result.rejectReason);
					}
					return undefined;
				}

				return this._bulkEditService.apply(result, { editor: this.editor }).then(result => {
					// alert
					if (result.ariaSummary) {
						alert(nls.localize('aria', "Successfully renamed '{0}' to '{1}'. Summary: {2}", loc.text, newNameOrFocusFlag, result.ariaSummary));
					}
				});

			}, err => {
				this._notificationService.error(nls.localize('rename.failed', "Rename failed to execute."));
				return TPromise.wrapError(err);
			}));

			this._progressService.showWhile(renameOperation, 250);
			return renameOperation;

		}, err => {
			this._renameInputVisible.reset();
			return TPromise.wrapError(err);
		});
	}

	public acceptRenameInput(): void {
		this._renameInputField.acceptInput();
	}

	public cancelRenameInput(): void {
		this._renameInputField.cancelInput(true);
	}
}

// ---- action implementation

export class RenameAction extends EditorAction {

	constructor() {
		super({
			id: 'editor.action.rename',
			label: nls.localize('rename.label', "Rename Symbol"),
			alias: 'Rename Symbol',
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasRenameProvider),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus,
				primary: KeyCode.F2,
				weight: KeybindingsRegistry.WEIGHT.editorContrib()
			},
			menuOpts: {
				group: '1_modification',
				order: 1.1
			}
		});
	}

	runCommand(accessor: ServicesAccessor, args: [URI, IPosition]): void | TPromise<void> {
		const editorService = accessor.get(ICodeEditorService);
		const [uri, pos] = args || [undefined, undefined];

		if (URI.isUri(uri) && Position.isIPosition(pos)) {
			return editorService.openCodeEditor({ resource: uri }, editorService.getActiveCodeEditor()).then(editor => {
				editor.setPosition(pos);
				editor.invokeWithinContext(accessor => {
					this.reportTelemetry(accessor, editor);
					return this.run(accessor, editor);
				});
			}, onUnexpectedError);
		}

		return super.runCommand(accessor, args);
	}

	run(accessor: ServicesAccessor, editor: ICodeEditor): TPromise<void> {
		let controller = RenameController.get(editor);
		if (controller) {
			return TPromise.wrap(controller.run());
		}
		return undefined;
	}
}

registerEditorContribution(RenameController);
registerEditorAction(RenameAction);

const RenameCommand = EditorCommand.bindToContribution<RenameController>(RenameController.get);

registerEditorCommand(new RenameCommand({
	id: 'acceptRenameInput',
	precondition: CONTEXT_RENAME_INPUT_VISIBLE,
	handler: x => x.acceptRenameInput(),
	kbOpts: {
		weight: KeybindingsRegistry.WEIGHT.editorContrib() + 99,
		kbExpr: EditorContextKeys.focus,
		primary: KeyCode.Enter
	}
}));

registerEditorCommand(new RenameCommand({
	id: 'cancelRenameInput',
	precondition: CONTEXT_RENAME_INPUT_VISIBLE,
	handler: x => x.cancelRenameInput(),
	kbOpts: {
		weight: KeybindingsRegistry.WEIGHT.editorContrib() + 99,
		kbExpr: EditorContextKeys.focus,
		primary: KeyCode.Escape,
		secondary: [KeyMod.Shift | KeyCode.Escape]
	}
}));

// ---- api bridge command

registerDefaultLanguageCommand('_executeDocumentRenameProvider', function (model, position, args) {
	let { newName } = args;
	if (typeof newName !== 'string') {
		throw illegalArgument('newName');
	}
	return rename(model, position, newName);
});
