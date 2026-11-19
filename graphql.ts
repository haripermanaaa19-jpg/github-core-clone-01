// graphql.ts: a small GraphQL parser and executor covering the documents the suite sends to
// POST /api/graphql — queries with variables, aliases, fragments and connections, the five
// mutations, and introspection for the types the rules name. It executes against the same store
// as REST, so ids and objects agree across surfaces.

import {
  VIEWER,
  USERS,
  branchTip,
  commentGlobalId,
  createIssue,
  createPull,
  forge,
  getObject,
  globalId,
  issueGlobalId,
  mergePull,
  parseGlobalId,
  pullFiles,
  pullMergeTree,
  repoGlobalId,
  userGlobalId,
  type CommentRec,
  type IssueRec,
  type RepoRec,
  type UserRec,
} from './store.ts';

// ---------------------------------------------------------------- tokenizer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            value += map[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: parseFloat(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  directives: Array<{ name: string; args: Array<{ name: string; value: ValueNode }> }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; directives: FieldNode['directives']; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string; directives: FieldNode['directives'] };

interface OperationDef {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

interface FragmentDef {
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ operation: token.value === 'mutation' ? 'mutation' : 'query', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'schema' || token.value === 'type' || token.value === 'input' || token.value === 'enum' || token.value === 'interface' || token.value === 'union' || token.value === 'scalar' || token.value === 'directive' || token.value === 'extend') {
        this.skipDefinition();
        continue;
      }
      throw new Error(`unexpected definition "${token.value}"`);
    }
    return { operations, fragments };
  }

  private skipDefinition(): void {
    // Skip a type-system definition: names, punctuation and one optional selection set.
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind === 'eof') return;
      if (token.kind === 'punct' && token.value === '{') depth += 1;
      if (token.kind === 'punct' && token.value === '}') {
        depth -= 1;
        if (depth <= 0) return;
      }
      if (depth === 0 && token.kind === 'name' && (token.value === 'type' || token.value === 'query' || token.value === 'mutation' || token.value === 'fragment')) {
        this.pos -= 1;
        return;
      }
    }
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseTypeRef();
      if (this.skipPunct('=')) this.parseValue();
      this.parseDirectives();
    }
  }

  private parseTypeRef(): void {
    if (this.skipPunct('[')) {
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): FieldNode['directives'] {
    const directives: FieldNode['directives'] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): FieldNode['args'] {
    const args: FieldNode['args'] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'fragmentSpread', name, directives };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selectionSet };
  }
}

// ---------------------------------------------------------------- schema definition

type TypeRef = { kind: 'named'; name: string } | { kind: 'nonNull' | 'list'; ofType: TypeRef };

const named = (name: string): TypeRef => ({ kind: 'named', name });
const nonNull = (ofType: TypeRef): TypeRef => ({ kind: 'nonNull', ofType });
const listOf = (ofType: TypeRef): TypeRef => ({ kind: 'list', ofType });

interface FieldDef {
  type: TypeRef;
  args?: Record<string, TypeRef>;
}

interface TypeDef {
  kind: 'OBJECT' | 'SCALAR' | 'ENUM' | 'INPUT_OBJECT';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  inputFields?: Record<string, TypeRef>;
}

const connectionArgs: Record<string, TypeRef> = {
  first: named('Int'),
  after: named('String'),
  last: named('Int'),
  before: named('String'),
};

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: nonNull(named('User')) },
      repository: { type: named('Repository'), args: { owner: nonNull(named('String')), name: nonNull(named('String')) } },
      node: { type: named('Node'), args: { id: nonNull(named('ID')) } },
      rateLimit: { type: named('RateLimit') },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: named('CreateIssuePayload'), args: { input: nonNull(named('CreateIssueInput')) } },
      closeIssue: { type: named('CloseIssuePayload'), args: { input: nonNull(named('CloseIssueInput')) } },
      createPullRequest: { type: named('CreatePullRequestPayload'), args: { input: nonNull(named('CreatePullRequestInput')) } },
      mergePullRequest: { type: named('MergePullRequestPayload'), args: { input: nonNull(named('MergePullRequestInput')) } },
      addComment: { type: named('AddCommentPayload'), args: { input: nonNull(named('AddCommentInput')) } },
    },
  },
  Node: { kind: 'OBJECT', fields: { id: { type: nonNull(named('ID')) } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      databaseId: { type: named('Int') },
      login: { type: nonNull(named('String')) },
      name: { type: named('String') },
    },
  },
  RepositoryOwner: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      login: { type: nonNull(named('String')) },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      databaseId: { type: named('Int') },
      name: { type: nonNull(named('String')) },
      nameWithOwner: { type: nonNull(named('String')) },
      description: { type: named('String') },
      isPrivate: { type: nonNull(named('Boolean')) },
      owner: { type: nonNull(named('User')) },
      defaultBranchRef: { type: named('Ref') },
      viewerPermission: { type: named('RepositoryPermission') },
      hasIssuesEnabled: { type: nonNull(named('Boolean')) },
      createdAt: { type: nonNull(named('DateTime')) },
      updatedAt: { type: nonNull(named('DateTime')) },
      issue: { type: named('Issue'), args: { number: nonNull(named('Int')) } },
      issues: {
        type: nonNull(named('IssueConnection')),
        args: { ...connectionArgs, states: listOf(nonNull(named('IssueState'))), orderBy: named('IssueOrder') },
      },
      pullRequest: { type: named('PullRequest'), args: { number: nonNull(named('Int')) } },
      pullRequests: {
        type: nonNull(named('PullRequestConnection')),
        args: { ...connectionArgs, states: listOf(nonNull(named('PullRequestState'))), orderBy: named('IssueOrder') },
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      name: { type: nonNull(named('String')) },
      prefix: { type: nonNull(named('String')) },
      target: { type: named('Commit') },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      oid: { type: nonNull(named('GitObjectID')) },
      message: { type: named('String') },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      databaseId: { type: named('Int') },
      number: { type: nonNull(named('Int')) },
      title: { type: nonNull(named('String')) },
      body: { type: named('String') },
      state: { type: nonNull(named('IssueState')) },
      repository: { type: nonNull(named('Repository')) },
      createdAt: { type: nonNull(named('DateTime')) },
      updatedAt: { type: nonNull(named('DateTime')) },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      databaseId: { type: named('Int') },
      number: { type: nonNull(named('Int')) },
      title: { type: nonNull(named('String')) },
      body: { type: named('String') },
      state: { type: nonNull(named('PullRequestState')) },
      merged: { type: nonNull(named('Boolean')) },
      mergedAt: { type: named('DateTime') },
      mergeable: { type: nonNull(named('PullRequestMergeableState')) },
      headRefName: { type: nonNull(named('String')) },
      baseRefName: { type: nonNull(named('String')) },
      headRefOid: { type: named('GitObjectID') },
      baseRefOid: { type: named('GitObjectID') },
      mergeCommit: { type: named('Commit') },
      repository: { type: nonNull(named('Repository')) },
      createdAt: { type: nonNull(named('DateTime')) },
      updatedAt: { type: nonNull(named('DateTime')) },
      files: { type: named('PullRequestChangedFileConnection'), args: { ...connectionArgs } },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: nonNull(named('ID')) },
      databaseId: { type: named('Int') },
      body: { type: named('String') },
      createdAt: { type: nonNull(named('DateTime')) },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: nonNull(named('String')) },
      additions: { type: named('Int') },
      deletions: { type: named('Int') },
      changeType: { type: named('String') },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: nonNull(named('Boolean')) },
      hasPreviousPage: { type: nonNull(named('Boolean')) },
      startCursor: { type: named('String') },
      endCursor: { type: named('String') },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: listOf(named('Issue')) },
      edges: { type: listOf(named('IssueEdge')) },
      pageInfo: { type: nonNull(named('PageInfo')) },
      totalCount: { type: nonNull(named('Int')) },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: named('Issue') }, cursor: { type: nonNull(named('String')) } } },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: listOf(named('PullRequest')) },
      edges: { type: listOf(named('PullRequestEdge')) },
      pageInfo: { type: nonNull(named('PageInfo')) },
      totalCount: { type: nonNull(named('Int')) },
    },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: named('PullRequest') }, cursor: { type: nonNull(named('String')) } } },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: listOf(named('PullRequestChangedFile')) },
      pageInfo: { type: nonNull(named('PageInfo')) },
      totalCount: { type: nonNull(named('Int')) },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: { type: nonNull(named('Int')) },
      remaining: { type: nonNull(named('Int')) },
      used: { type: nonNull(named('Int')) },
      resetAt: { type: nonNull(named('DateTime')) },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { clientMutationId: { type: named('String') }, issue: { type: named('Issue') } },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { clientMutationId: { type: named('String') }, issue: { type: named('Issue') } },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { clientMutationId: { type: named('String') }, pullRequest: { type: named('PullRequest') } },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { clientMutationId: { type: named('String') }, pullRequest: { type: named('PullRequest') } },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      clientMutationId: { type: named('String') },
      commentEdge: { type: named('IssueCommentEdge') },
      subject: { type: named('Issue') },
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: { node: { type: named('IssueComment') }, cursor: { type: nonNull(named('String')) } },
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: nonNull(named('ID')), title: nonNull(named('String')), body: named('String'), clientMutationId: named('String') },
  },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: nonNull(named('ID')), clientMutationId: named('String') } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: nonNull(named('ID')),
      baseRefName: nonNull(named('String')),
      headRefName: nonNull(named('String')),
      title: nonNull(named('String')),
      body: named('String'),
      clientMutationId: named('String'),
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { pullRequestId: nonNull(named('ID')), mergeMethod: named('PullRequestMergeMethod'), clientMutationId: named('String') },
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { subjectId: nonNull(named('ID')), body: nonNull(named('String')), clientMutationId: named('String') },
  },
  IssueOrder: { kind: 'INPUT_OBJECT', inputFields: { field: named('IssueOrderField'), direction: named('OrderDirection') } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'REBASE', 'SQUASH'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
};

// ---------------------------------------------------------------- values

interface RepoVal {
  __typename: 'Repository';
  repo: RepoRec;
}
interface IssueVal {
  __typename: 'Issue' | 'PullRequest';
  repo: RepoRec;
  issue: IssueRec;
}
interface CommentVal {
  __typename: 'IssueComment';
  repo: RepoRec;
  issue: IssueRec;
  comment: CommentRec;
}
interface UserVal {
  __typename: 'User';
  user: UserRec;
}

function repoVal(repo: RepoRec): RepoVal {
  return { __typename: 'Repository', repo };
}
function issueVal(repo: RepoRec, issue: IssueRec): IssueVal {
  return { __typename: issue.kind === 'pull' ? 'PullRequest' : 'Issue', repo, issue };
}
function userVal(user: UserRec): UserVal {
  return { __typename: 'User', user };
}

function userByLogin(login: string): UserRec {
  return USERS.find((user) => user.login === login) ?? { id: 0, login, name: login, email: `${login}@example.invalid` };
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string') return -1;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : parseInt(match[1], 10);
  } catch {
    return -1;
  }
}

interface Connection {
  __typename: string;
  nodes: unknown[];
  edges: Array<{ __typename: string; node: unknown; cursor: string }>;
  pageInfo: { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
}

function makeConnection(typeName: string, edgeTypeName: string, items: readonly unknown[], args: Record<string, unknown>): Connection {
  const first = typeof args.first === 'number' ? args.first : 30;
  const start = indexOfCursor(args.after) + 1;
  const slice = items.slice(start, start + first);
  const nodes = [...slice];
  const edges = slice.map((node, i) => ({ __typename: edgeTypeName, node, cursor: cursorOf(start + i) }));
  return {
    __typename: typeName,
    nodes,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(start) : null,
      endCursor: slice.length > 0 ? cursorOf(start + slice.length - 1) : null,
    },
    totalCount: items.length,
  };
}

// ---------------------------------------------------------------- execution

class GqlError extends Error {}

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function valueFromNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueFromNode(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueFromNode(arg.value, ctx.variables);
  return out;
}

function directivesAllow(directives: FieldNode['directives'], ctx: ExecCtx): boolean {
  for (const directive of directives) {
    if (directive.name === 'skip' || directive.name === 'include') {
      const ifArg = directive.args.find((arg) => arg.name === 'if');
      const value = ifArg === undefined ? undefined : valueFromNode(ifArg.value, ctx.variables);
      if (directive.name === 'skip' && value === true) return false;
      if (directive.name === 'include' && value === false) return false;
    }
  }
  return true;
}

type Resolver = (source: never, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function repoFromGlobalId(id: unknown): RepoRec | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  return forge.reposById.get(parseInt(parsed.key, 10)) ?? null;
}

function issueFromGlobalId(id: unknown): { repo: RepoRec; issue: IssueRec } | null {
  if (typeof id !== 'string') return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) return null;
  const [repoId, number] = parsed.key.split(':');
  const repo = forge.reposById.get(parseInt(repoId, 10));
  if (repo === undefined) return null;
  const issue = repo.issues.get(parseInt(number, 10));
  if (issue === undefined) return null;
  return { repo, issue };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userVal(VIEWER),
    repository: (_s, args) => {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === null ? null : repoVal(repo);
    },
    node: (_s, args) => {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = forge.reposById.get(parseInt(parsed.key, 10));
        return repo === undefined ? null : repoVal(repo);
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const found = issueFromGlobalId(id);
        return found === null ? null : issueVal(found.repo, found.issue);
      }
      if (parsed.type === 'IssueComment') {
        const [repoId, commentId] = parsed.key.split(':');
        const repo = forge.reposById.get(parseInt(repoId, 10));
        if (repo === undefined) return null;
        for (const issue of repo.issues.values()) {
          const comment = issue.comments.find((candidate) => candidate.id === parseInt(commentId, 10));
          if (comment !== undefined) return { __typename: 'IssueComment', repo, issue, comment } as CommentVal;
        }
        return null;
      }
      if (parsed.type === 'User') {
        const user = USERS.find((candidate) => candidate.id === parseInt(parsed.key, 10));
        return user === undefined ? null : userVal(user);
      }
      return null;
    },
    rateLimit: () => ({
      __typename: 'RateLimit',
      limit: 5000,
      remaining: 5000,
      used: 0,
      resetAt: forge.isoOf(3600),
    }),
  },
  Mutation: {
    createIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(input.repositoryId);
      if (repo === null) throw new GqlError('Repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = createIssue(repo, title, body, []);
      return { __typename: 'CreateIssuePayload', clientMutationId: input.clientMutationId ?? null, issue: issueVal(repo, issue) };
    },
    closeIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(input.issueId);
      if (found === null) throw new GqlError('Issue not found');
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', clientMutationId: input.clientMutationId ?? null, issue: issueVal(found.repo, found.issue) };
    },
    createPullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoFromGlobalId(input.repositoryId);
      if (repo === null) throw new GqlError('Repository not found');
      const pull = createPull(
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if (pull === null) throw new GqlError('Head or base ref does not exist');
      return { __typename: 'CreatePullRequestPayload', clientMutationId: input.clientMutationId ?? null, pullRequest: issueVal(repo, pull) };
    },
    mergePullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(input.pullRequestId);
      if (found === null || found.issue.kind !== 'pull') throw new GqlError('Pull request not found');
      if (!found.issue.pull?.merged) {
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
        const merged = mergePull(found.repo, found.issue, method);
        if (merged === null) throw new GqlError('Pull request is not mergeable');
      }
      return { __typename: 'MergePullRequestPayload', clientMutationId: input.clientMutationId ?? null, pullRequest: issueVal(found.repo, found.issue) };
    },
    addComment: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueFromGlobalId(input.subjectId);
      if (found === null) throw new GqlError('Subject not found');
      const comment: CommentRec = {
        id: forge.allocCommentDbId(),
        body: typeof input.body === 'string' ? input.body : '',
        seq: forge.tick(),
      };
      found.issue.comments.push(comment);
      const commentVal: CommentVal = { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment };
      return {
        __typename: 'AddCommentPayload',
        clientMutationId: input.clientMutationId ?? null,
        commentEdge: { __typename: 'IssueCommentEdge', node: commentVal, cursor: cursorOf(found.issue.comments.length - 1) },
        subject: issueVal(found.repo, found.issue),
      };
    },
  },
  User: {
    id: (s: UserVal) => userGlobalId(s.user),
    databaseId: (s: UserVal) => s.user.id,
    login: (s: UserVal) => s.user.login,
    name: (s: UserVal) => s.user.name,
  },
  Repository: {
    id: (s: RepoVal) => repoGlobalId(s.repo),
    databaseId: (s: RepoVal) => s.repo.dbId,
    name: (s: RepoVal) => s.repo.name,
    nameWithOwner: (s: RepoVal) => `${s.repo.owner}/${s.repo.name}`,
    description: (s: RepoVal) => s.repo.description,
    isPrivate: (s: RepoVal) => s.repo.isPrivate,
    owner: (s: RepoVal) => userVal(userByLogin(s.repo.owner)),
    defaultBranchRef: (s: RepoVal) => {
      const tip = branchTip(s.repo, s.repo.defaultBranch);
      if (tip === null) return null;
      return { __typename: 'Ref', name: s.repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip, repo: s.repo } };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (s: RepoVal) => forge.isoOf(s.repo.seq),
    updatedAt: (s: RepoVal) => forge.isoOf(s.repo.seq),
    issue: (s: RepoVal, args) => {
      const record = s.repo.issues.get(Number(args.number));
      if (record === undefined || record.kind !== 'issue') return null;
      return issueVal(s.repo, record);
    },
    issues: (s: RepoVal, args) => {
      let records = [...s.repo.issues.values()].filter((record) => record.kind === 'issue');
      if (Array.isArray(args.states)) {
        const states = new Set((args.states as unknown[]).map((state) => String(state).toLowerCase()));
        records = records.filter((record) => states.has(record.state));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      const descending = orderBy?.direction === 'DESC';
      records.sort((a, b) => (descending ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
      return makeConnection('IssueConnection', 'IssueEdge', records.map((record) => issueVal(s.repo, record)), args);
    },
    pullRequest: (s: RepoVal, args) => {
      const record = s.repo.issues.get(Number(args.number));
      if (record === undefined || record.kind !== 'pull') return null;
      return issueVal(s.repo, record);
    },
    pullRequests: (s: RepoVal, args) => {
      let records = [...s.repo.issues.values()].filter((record) => record.kind === 'pull');
      if (Array.isArray(args.states)) {
        const states = new Set((args.states as unknown[]).map((state) => String(state)));
        records = records.filter((record) => states.has(record.pull?.merged ? 'MERGED' : record.state.toUpperCase()));
      }
      records.sort((a, b) => a.seq - b.seq || a.number - b.number);
      return makeConnection('PullRequestConnection', 'PullRequestEdge', records.map((record) => issueVal(s.repo, record)), args);
    },
  },
  Ref: {
    id: (s: { name: string }) => globalId('Ref', s.name),
    name: (s: { name: string }) => s.name,
    prefix: () => 'refs/heads/',
    target: (s: { target?: unknown }) => s.target ?? null,
  },
  Commit: {
    id: (s: { oid: string }) => globalId('Commit', s.oid),
    oid: (s: { oid: string }) => s.oid,
    message: (s: { oid: string; repo?: RepoRec }) => {
      if (s.repo === undefined) return null;
      const object = getObject(s.repo, s.oid);
      if (object === null || object.type !== 'commit') return null;
      const text = object.data.toString('utf8');
      const blank = text.indexOf('\n\n');
      return blank < 0 ? '' : text.slice(blank + 2);
    },
  },
  Issue: {
    id: (s: IssueVal) => issueGlobalId(s.repo, s.issue),
    databaseId: (s: IssueVal) => s.issue.dbId,
    number: (s: IssueVal) => s.issue.number,
    title: (s: IssueVal) => s.issue.title,
    body: (s: IssueVal) => s.issue.body,
    state: (s: IssueVal) => s.issue.state.toUpperCase(),
    repository: (s: IssueVal) => repoVal(s.repo),
    createdAt: (s: IssueVal) => forge.isoOf(s.issue.seq),
    updatedAt: (s: IssueVal) => forge.isoOf(s.issue.seq),
  },
  PullRequest: {
    id: (s: IssueVal) => issueGlobalId(s.repo, s.issue),
    databaseId: (s: IssueVal) => s.issue.dbId,
    number: (s: IssueVal) => s.issue.number,
    title: (s: IssueVal) => s.issue.title,
    body: (s: IssueVal) => s.issue.body,
    state: (s: IssueVal) => (s.issue.pull?.merged ? 'MERGED' : s.issue.state.toUpperCase()),
    merged: (s: IssueVal) => s.issue.pull?.merged ?? false,
    mergedAt: (s: IssueVal) => (s.issue.pull?.merged ? forge.isoOf(s.issue.pull.mergedSeq) : null),
    mergeable: (s: IssueVal) => {
      if (s.issue.pull?.merged) return 'MERGEABLE';
      return pullMergeTree(s.repo, s.issue) !== null ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (s: IssueVal) => s.issue.pull?.headRef ?? '',
    baseRefName: (s: IssueVal) => s.issue.pull?.baseRef ?? '',
    headRefOid: (s: IssueVal) => (s.issue.pull === null ? null : branchTip(s.repo, s.issue.pull.headRef)),
    baseRefOid: (s: IssueVal) => (s.issue.pull === null ? null : branchTip(s.repo, s.issue.pull.baseRef)),
    mergeCommit: (s: IssueVal) => {
      if (!s.issue.pull?.merged || s.issue.pull.mergeCommitSha === '') return null;
      return { __typename: 'Commit', oid: s.issue.pull.mergeCommitSha, repo: s.repo };
    },
    repository: (s: IssueVal) => repoVal(s.repo),
    createdAt: (s: IssueVal) => forge.isoOf(s.issue.seq),
    updatedAt: (s: IssueVal) => forge.isoOf(s.issue.seq),
    files: (s: IssueVal, args) => {
      const files = pullFiles(s.repo, s.issue).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      }));
      return makeConnection('PullRequestChangedFileConnection', 'PullRequestChangedFileEdge', files, args);
    },
  },
  IssueComment: {
    id: (s: CommentVal) => commentGlobalId(s.repo, s.comment),
    databaseId: (s: CommentVal) => s.comment.id,
    body: (s: CommentVal) => s.comment.body,
    createdAt: (s: CommentVal) => forge.isoOf(s.comment.seq),
  },
};

// ---------------------------------------------------------------- introspection

interface TypeView {
  __typename: '__Type';
  kind: string;
  name: string | null;
  def: TypeDef | null;
  ofType: TypeView | null;
}

function typeViewOfRef(ref: TypeRef): TypeView {
  if (ref.kind === 'named') {
    return { __typename: '__Type', kind: SCHEMA[ref.name]?.kind ?? 'SCALAR', name: ref.name, def: SCHEMA[ref.name] ?? null, ofType: null };
  }
  return { __typename: '__Type', kind: ref.kind === 'nonNull' ? 'NON_NULL' : 'LIST', name: null, def: null, ofType: typeViewOfRef(ref.ofType) };
}

function typeViewOfDef(name: string): TypeView {
  const def = SCHEMA[name];
  return { __typename: '__Type', kind: def?.kind ?? 'SCALAR', name, def: def ?? null, ofType: null };
}

RESOLVERS.__Type = {
  name: (s: TypeView) => s.name,
  kind: (s: TypeView) => s.kind,
  description: () => null,
  fields: (s: TypeView) => {
    if (s.def === null || s.def.kind !== 'OBJECT' || s.def.fields === undefined) return null;
    return Object.entries(s.def.fields).map(([name, field]) => ({
      __typename: '__Field',
      name,
      description: null,
      args: Object.entries(field.args ?? {}).map(([argName, argType]) => ({ __typename: '__InputValue', name: argName, type: typeViewOfRef(argType), defaultValue: null })),
      type: typeViewOfRef(field.type),
      isDeprecated: false,
      deprecationReason: null,
    }));
  },
  enumValues: (s: TypeView) => {
    if (s.def === null || s.def.kind !== 'ENUM' || s.def.enumValues === undefined) return null;
    return s.def.enumValues.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
  },
  inputFields: (s: TypeView) => {
    if (s.def === null || s.def.kind !== 'INPUT_OBJECT' || s.def.inputFields === undefined) return null;
    return Object.entries(s.def.inputFields).map(([name, type]) => ({ __typename: '__InputValue', name, type: typeViewOfRef(type), defaultValue: null }));
  },
  ofType: (s: TypeView) => s.ofType,
  possibleTypes: () => null,
  specifiedByURL: () => null,
} as Record<string, Resolver>;

RESOLVERS.__Field = {
  name: (s: { name: string }) => s.name,
  description: () => null,
  args: (s: { args: unknown }) => s.args,
  type: (s: { type: unknown }) => s.type,
  isDeprecated: () => false,
  deprecationReason: () => null,
} as Record<string, Resolver>;

RESOLVERS.__InputValue = {
  name: (s: { name: string }) => s.name,
  description: () => null,
  type: (s: { type: unknown }) => s.type,
  defaultValue: () => null,
} as Record<string, Resolver>;

RESOLVERS.__EnumValue = {
  name: (s: { name: string }) => s.name,
  description: () => null,
  isDeprecated: () => false,
  deprecationReason: () => null,
} as Record<string, Resolver>;

RESOLVERS.__Schema = {
  types: () => Object.keys(SCHEMA).map((name) => typeViewOfDef(name)),
  queryType: () => typeViewOfDef('Query'),
  mutationType: () => typeViewOfDef('Mutation'),
  subscriptionType: () => null,
  directives: () => [],
} as Record<string, Resolver>;

SCHEMA.__Type = {
  kind: 'OBJECT',
  fields: {
    name: { type: named('String') },
    kind: { type: nonNull(named('__TypeKind')) },
    description: { type: named('String') },
    fields: { type: listOf(nonNull(named('__Field'))), args: { includeDeprecated: named('Boolean') } },
    enumValues: { type: listOf(nonNull(named('__EnumValue'))), args: { includeDeprecated: named('Boolean') } },
    inputFields: { type: listOf(nonNull(named('__InputValue'))) },
    ofType: { type: named('__Type') },
    possibleTypes: { type: listOf(nonNull(named('__Type'))) },
    specifiedByURL: { type: named('String') },
  },
};
SCHEMA.__Field = {
  kind: 'OBJECT',
  fields: {
    name: { type: nonNull(named('String')) },
    description: { type: named('String') },
    args: { type: nonNull(listOf(nonNull(named('__InputValue')))) },
    type: { type: nonNull(named('__Type')) },
    isDeprecated: { type: nonNull(named('Boolean')) },
    deprecationReason: { type: named('String') },
  },
};
SCHEMA.__InputValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: nonNull(named('String')) },
    description: { type: named('String') },
    type: { type: nonNull(named('__Type')) },
    defaultValue: { type: named('String') },
  },
};
SCHEMA.__EnumValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: nonNull(named('String')) },
    description: { type: named('String') },
    isDeprecated: { type: nonNull(named('Boolean')) },
    deprecationReason: { type: named('String') },
  },
};
SCHEMA.__Schema = {
  kind: 'OBJECT',
  fields: {
    types: { type: nonNull(listOf(nonNull(named('__Type')))) },
    queryType: { type: nonNull(named('__Type')) },
    mutationType: { type: named('__Type') },
    subscriptionType: { type: named('__Type') },
    directives: { type: nonNull(listOf(nonNull(named('__Directive')))) },
  },
};
SCHEMA.__TypeKind = { kind: 'ENUM', enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'] };
SCHEMA.__Directive = {
  kind: 'OBJECT',
  fields: {
    name: { type: nonNull(named('String')) },
    description: { type: named('String') },
    locations: { type: nonNull(listOf(nonNull(named('__DirectiveLocation')))) },
    args: { type: nonNull(listOf(nonNull(named('__InputValue')))) },
  },
};
SCHEMA.__DirectiveLocation = { kind: 'ENUM', enumValues: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'] };

// ---------------------------------------------------------------- executor

function typeNameOf(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null && '__typename' in value) {
    const name = (value as { __typename: unknown }).__typename;
    if (typeof name === 'string') return name;
  }
  return fallback;
}

function executeSelectionSet(source: unknown, typeName: string, selections: readonly SelectionNode[], ctx: ExecCtx, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const visit = (selectionList: readonly SelectionNode[], currentType: string, currentSource: unknown): void => {
    for (const selection of selectionList) {
      if (!directivesAllow(selection.directives, ctx)) continue;
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition === null || selection.typeCondition === currentType) visit(selection.selectionSet, currentType, currentSource);
        else {
          // An inline fragment on another type still applies when the runtime type matches it.
          const runtimeType = typeNameOf(currentSource, currentType);
          if (selection.typeCondition === runtimeType) visit(selection.selectionSet, runtimeType, currentSource);
        }
        continue;
      }
      if (selection.kind === 'fragmentSpread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment === undefined) continue;
        const runtimeType = typeNameOf(currentSource, currentType);
        if (fragment.typeCondition === currentType || fragment.typeCondition === runtimeType || fragment.typeCondition === 'Node') {
          visit(fragment.selectionSet, fragment.typeCondition === 'Node' ? currentType : fragment.typeCondition, currentSource);
        }
        continue;
      }
      const responseKey = selection.alias ?? selection.name;
      out[responseKey] = executeField(currentSource, currentType, selection, ctx, [...path, responseKey]);
    }
  };
  visit(selections, typeName, source);
  return out;
}

function executeField(source: unknown, typeName: string, field: FieldNode, ctx: ExecCtx, path: Array<string | number>): unknown {
  const name = field.name;
  if (name === '__typename') return typeNameOf(source, typeName);
  if (typeName === 'Query' && name === '__type') {
    const args = argsOf(field, ctx);
    const typeNameArg = typeof args.name === 'string' ? args.name : '';
    const view = SCHEMA[typeNameArg] === undefined ? null : typeViewOfDef(typeNameArg);
    return completeValue(view, '__Type', field, ctx, path);
  }
  if (typeName === 'Query' && name === '__schema') {
    return completeValue({ __typename: '__Schema' }, '__Schema', field, ctx, path);
  }
  const def = SCHEMA[typeName];
  const fieldDef = def?.fields?.[name];
  const resolver = RESOLVERS[typeName]?.[name];
  if (fieldDef === undefined || (resolver === undefined && def?.kind !== 'OBJECT')) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".`, path });
    return null;
  }
  let value: unknown;
  try {
    if (resolver !== undefined) value = resolver(source as never, argsOf(field, ctx), ctx);
    else if (typeof source === 'object' && source !== null && name in source) {
      const property = (source as Record<string, unknown>)[name];
      value = typeof property === 'function' ? (property as () => unknown).call(source) : property;
    } else value = null;
  } catch (error) {
    ctx.errors.push({ message: error instanceof Error ? error.message : String(error), path });
    return null;
  }
  const declared = fieldDef !== undefined ? namedTypeOf(fieldDef.type) : null;
  return completeValue(value, declared, field, ctx, path);
}

function namedTypeOf(ref: TypeRef): string {
  return ref.kind === 'named' ? ref.name : namedTypeOf(ref.ofType);
}

function completeValue(value: unknown, declaredType: string | null, field: FieldNode, ctx: ExecCtx, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(item, declaredType, field, ctx, [...path, index]));
  }
  if (typeof value === 'object') {
    if (field.selectionSet === null) return value;
    const runtimeType = typeNameOf(value, declaredType ?? 'Query');
    return executeSelectionSet(value, runtimeType, field.selectionSet, ctx, path);
  }
  return value;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: Array<string | number> }>;
}

/** Execute one GraphQL operation object ({query, variables, operationName}). */
export function executeGraphQL(request: { query?: unknown; variables?: unknown; operationName?: unknown }): GraphQLResult {
  if (typeof request.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query string is required' }] };
  }
  let document: Document;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'Parse error' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'No operation found' }] };
  let operation = document.operations[0];
  if (typeof request.operationName === 'string') {
    operation = document.operations.find((candidate) => candidate.name === request.operationName) ?? operation;
  }
  const variables = (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>;
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet({}, rootType, operation.selectionSet, ctx, []);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
