import { MagitChange } from '../models/magitChange';
import { workspace, window, ViewColumn, Range, commands, Uri } from 'vscode';
import { gitApi, magitRepositories, views } from '../extension';
import FilePathUtils from '../utils/filePathUtils';
import GitTextUtils from '../utils/gitTextUtils';
import { MagitRepository } from '../models/magitRepository';
import MagitUtils from '../utils/magitUtils';
import MagitStatusView from '../views/magitStatusView';
import { Status, Commit, RefType } from '../typings/git';
import { MagitBranch } from '../models/magitBranch';
import { Section } from '../views/general/sectionHeader';
import { gitRun } from '../utils/gitRawRunner';
import * as Constants from '../common/constants';
import { getCommit } from '../utils/commitCache';

export async function magitRefresh() { }

export async function magitStatus(preserveFocus = false): Promise<any> {

  if (window.activeTextEditor) {

    const activeWorkspaceFolder = workspace.getWorkspaceFolder(window.activeTextEditor.document.uri);

    if (activeWorkspaceFolder) {

      const workspaceRootPath = activeWorkspaceFolder.uri.path;

      let repository: MagitRepository | undefined;

      // MINOR: Any point in reusing repo?
      // This might make magit LESS resilient to changes in workspace etc.
      for (const [key, repo] of magitRepositories.entries()) {
        if (FilePathUtils.isDescendant(key, workspaceRootPath)) {
          repository = repo;
          break;
        }
      }

      if (repository) {
        for (const [uri, view] of views ?? []) {
          if (view instanceof MagitStatusView) {
            // Resuses doc, if still exists. Which it should if the view still exists
            // Open and focus magit status view
            // Run update
            await MagitUtils.magitStatusAndUpdate(repository, view);
            console.log('Update existing view');
            return workspace.openTextDocument(view.uri).then(doc => window.showTextDocument(doc, { viewColumn: ViewColumn.Beside, preserveFocus, preview: false }));
          }
        }
      } else {
        console.log('load repo from git api (not map)');
        repository = gitApi.repositories.filter(r => FilePathUtils.isDescendant(r.rootUri.path, workspaceRootPath))[0];
      }

      if (repository) {
        const magitRepo: MagitRepository = repository;
        magitRepositories.set(repository.rootUri.path, repository);

        await internalMagitStatus(magitRepo);

        const uri = MagitStatusView.encodeLocation(magitRepo.rootUri.path);
        views.set(uri.toString(), new MagitStatusView(uri, magitRepo.magitState!));

        return workspace.openTextDocument(uri).then(doc => window.showTextDocument(doc, { viewColumn: ViewColumn.Beside, preserveFocus, preview: false }))

          // TODO LATE PRI: branch highlighting...
          // THIS WORKS
          // Decorations could be added by the views in the view hierarchy?
          // yes as we go down the hierarchy make these decorations at exactly the points wanted
          // and should be pretty simple to collect them and set the editors decorations
          // needs something super smart.. https://github.com/Microsoft/vscode/issues/585
          // .then(e => e.setDecorations(
          //   window.createTextEditorDecorationType({
          //     color: 'rgba(100,200,100,0.5)',
          //     border: '0.1px solid grey'
          //   }), [new Range(0, 11, 0, 17)]))
          // MINOR: clean up all of this
          .then(() => {
            return commands.executeCommand('editor.foldLevel2');
          });

      } else {
        // Prompt to create repo
        const newRepo = await commands.executeCommand('git.init');
        if (newRepo) {
          return magitStatus();
        }
      }
    }
    else {
      // MINOR: could be nice to rather show the list of repos to choose from?
      throw new Error('Current file not part of a workspace');
    }
  }
}

export async function internalMagitStatus(repository: MagitRepository): Promise<void> {

  await repository.status();

  const dotGitPath = repository.rootUri + '/.git/';
  const interestingCommits: string[] = [];


  const stashTask = repository._repository.getStashes();

  const logTask = repository.state.HEAD?.commit ? repository.log({ maxEntries: 10 }) : [];

  if (repository.state.HEAD?.commit) {
    interestingCommits.push(repository.state.HEAD?.commit);
  }

  let commitsAhead: string[] = [], commitsBehind: string[] = [];
  if (repository.state.HEAD?.ahead || repository.state.HEAD?.behind) {
    const ref = repository.state.HEAD.name;
    const args = ['rev-list', '--left-right', `${ref}...${ref}@{u}`];
    const res = (await gitRun(repository, args)).stdout;
    [commitsAhead, commitsBehind] = GitTextUtils.parseRevListLeftRight(res);
    interestingCommits.push(...[...commitsAhead, ...commitsBehind]);
  }

  const untrackedFiles: MagitChange[] = [];

  const workingTreeChanges_NoUntracked = repository.state.workingTreeChanges
    .filter(c => {
      if (c.status === Status.UNTRACKED) {
        const magitChange: MagitChange = c;
        magitChange.section = Section.Untracked;
        magitChange.relativePath = FilePathUtils.uriPathRelativeTo(c.uri, repository.rootUri);
        untrackedFiles.push(magitChange);
        return false;
      }
      return true;
    });

  const workingTreeChangesTasks = Promise.all(workingTreeChanges_NoUntracked
    .map(async change => {
      const diff = await repository.diffWithHEAD(change.uri.path);
      const magitChange: MagitChange = change;
      magitChange.section = Section.Unstaged;
      magitChange.relativePath = FilePathUtils.uriPathRelativeTo(change.uri, repository.rootUri);
      magitChange.hunks = GitTextUtils.diffToHunks(diff, change.uri, Section.Unstaged);
      return magitChange;
    }));

  const indexChangesTasks = Promise.all(repository.state.indexChanges
    .map(async change => {
      const diff = await repository.diffIndexWithHEAD(change.uri.path);
      const magitChange: MagitChange = change;
      magitChange.section = Section.Staged;
      magitChange.relativePath = FilePathUtils.uriPathRelativeTo(change.uri, repository.rootUri);
      magitChange.hunks = GitTextUtils.diffToHunks(diff, change.uri, Section.Staged);
      return magitChange;
    }));

  const mergeChangesTasks = Promise.all(repository.state.mergeChanges
    .map(async change => {
      const diff = await repository.diffWithHEAD(change.uri.path);
      const magitChange: MagitChange = change;
      magitChange.section = Section.Staged;
      magitChange.relativePath = FilePathUtils.uriPathRelativeTo(change.uri, repository.rootUri);
      magitChange.hunks = GitTextUtils.diffToHunks(diff, change.uri, Section.Staged);
      return magitChange;
    }));

  const mergeHeadPath = Uri.parse(dotGitPath + 'MERGE_HEAD');
  const mergeMsgPath = Uri.parse(dotGitPath + 'MERGE_MSG');
  const mergeHeadFileTask = workspace.fs.readFile(mergeHeadPath).then(f => f.toString());
  const mergeMsgFileTask = workspace.fs.readFile(mergeMsgPath).then(f => f.toString());

  const rebaseHeadNamePath = Uri.parse(dotGitPath + 'rebase-apply/head-name');
  const rebaseOntoPath = Uri.parse(dotGitPath + 'rebase-apply/onto');

  let rebaseHeadNameFileTask: Thenable<string>;
  let rebaseOntoPathFileTask: Thenable<string>;
  let rebaseCommitListTask: Thenable<Commit[]> | undefined = undefined;
  let rebaseNextIndex: number = 0;

  if (repository.state.rebaseCommit) {
    rebaseHeadNameFileTask = workspace.fs.readFile(rebaseHeadNamePath).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''));
    rebaseOntoPathFileTask = workspace.fs.readFile(rebaseOntoPath).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''));

    const rebaseLastIndexTask = workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-apply/last')).then(f => f.toString().replace(Constants.FinalLineBreakRegex, '')).then(Number.parseInt);
    rebaseNextIndex = await workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-apply/next')).then(f => f.toString().replace(Constants.FinalLineBreakRegex, '')).then(Number.parseInt);

    const indices: number[] = [];

    for (let i = await rebaseLastIndexTask; i > rebaseNextIndex; i--) {
      indices.push(i);
    }

    rebaseCommitListTask =
      Promise.all(
        indices.map(
          index => workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-apply/' + index.toString().padStart(4, '0'))).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''))
            .then(GitTextUtils.commitDetailTextToCommit)
        ));
  }

  const commitTasks = Promise.all(
    interestingCommits
      .map(c => getCommit(repository, c)));

  let mergingState;
  try {
    const parsedMergeState = GitTextUtils.parseMergeStatus(await mergeHeadFileTask, await mergeMsgFileTask);

    if (parsedMergeState) {
      const [mergeCommits, mergingBranches] = parsedMergeState;
      mergingState = {
        mergingBranches,
        commits: await Promise.all(mergeCommits.map(c => getCommit(repository, c)))
      };
    }
  } catch { }

  const log = await logTask;

  let rebasingState;
  if (repository.state.rebaseCommit) {

    const ontoCommit = await getCommit(repository, await rebaseOntoPathFileTask!);

    const ontoBranch = repository.state.refs.find(ref => ref.commit === ontoCommit.hash && ref.type !== RefType.RemoteHead) as MagitBranch;
    ontoBranch.commitDetails = ontoCommit;

    const doneCommits: Commit[] = log.slice(0, rebaseNextIndex - 1);
    const upcomingCommits: Commit[] = (await rebaseCommitListTask) ?? [];

    rebasingState = {
      currentCommit: repository.state.rebaseCommit,
      origBranchName: (await rebaseHeadNameFileTask!).split('/')[2],
      ontoBranch,
      doneCommits,
      upcomingCommits
    };
  }

  const commitMap: { [id: string]: Commit; } = (await commitTasks).reduce((prev, commit) => ({ ...prev, [commit.hash]: commit }), {});

  const HEAD = repository.state.HEAD as MagitBranch | undefined;

  if (HEAD?.commit) {
    HEAD.commitDetails = commitMap[HEAD.commit];
    // Resolve tag at HEAD
    HEAD.tag = repository.state.refs.find(r => HEAD?.commit === r.commit && r.type === RefType.Tag);

    HEAD.commitsAhead = commitsAhead.map(hash => commitMap[hash]);
    HEAD.commitsBehind = commitsBehind.map(hash => commitMap[hash]);

    // MINOR: clean up?
    try {
      const pushRemote = await repository.getConfig(`branch.${HEAD.name}.pushRemote`);

      const upstreamRemote = HEAD.upstream?.remote;

      const upstreamRemoteCommit = repository.state.refs.find(ref => ref.remote === upstreamRemote && ref.name === `${upstreamRemote}/${HEAD.upstream?.name}`)?.commit;
      const upstreamRemoteCommitDetails = upstreamRemoteCommit ? getCommit(repository, upstreamRemoteCommit) : undefined;

      const pushRemoteCommit = repository.state.refs.find(ref => ref.remote === pushRemote && ref.name === `${pushRemote}/${HEAD.name}`)?.commit;
      const pushRemoteCommitDetails = pushRemoteCommit ? getCommit(repository, pushRemoteCommit) : undefined;

      HEAD.pushRemote = { remote: pushRemote, name: HEAD.name!, commit: await pushRemoteCommitDetails };

      if (HEAD.upstream) {
        HEAD.upstreamRemote = HEAD.upstream;
        HEAD.upstreamRemote.commit = await upstreamRemoteCommitDetails;

      }
    } catch { }
  }

  // MINOR: state ONchange might be interesting
  // repository.state.onDidChange
  // Use instead of onDidSave document? might be better to let vscode handle it, instead of doubling up potentially
  // just need to re-render without calling repository.status()

  repository.magitState = {
    HEAD,
    stashes: await stashTask,
    log,
    workingTreeChanges: await workingTreeChangesTasks,
    indexChanges: await indexChangesTasks,
    mergeChanges: await mergeChangesTasks,
    untrackedFiles,
    rebasingState,
    mergingState,
    latestGitError: repository.magitState?.latestGitError
  };
}