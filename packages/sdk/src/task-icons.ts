/**
 * What a task wears on its tab: one glyph from a short curated set, in one
 * colour from a shorter one.
 *
 * Every task has both. A new task gets the defaults — a dashed circle in the
 * faded grey, which reads as "nothing chosen yet" without being nothing at all —
 * and an extension that creates tasks of its own kind picks an icon for them
 * when it creates them (see `tasks.create`). The user changes either by
 * clicking the glyph on the tab.
 *
 * Curated rather than the whole of Phosphor for two reasons. The picker is a
 * grid to scan at a glance, so the list is ordered by what the work is about:
 * related glyphs sit together, and the first row is the one most tasks want.
 * And the app generates icon CSS by scanning source text for literal class
 * names, so each entry carries its class written out in full; one assembled at
 * runtime would draw nothing.
 *
 * The order is the picker's and nothing else's: tasks store the id, so entries
 * can be moved freely. Removing one is safe too (see `taskIcon`), but renaming
 * an id orphans every task that wears it.
 */

export type TaskIconInfo = {
  /** What is stored on the task. The Phosphor name, so it reads as what it draws. */
  id: string
  /** What the picker calls it. */
  label: string
  /** The Iconify class, written out in full: see above. */
  className: string
  /** Other words the picker's search should find it by. */
  keywords: readonly string[]
}

export const TASK_ICONS = [
  // Status and priority: what state the work is in, and how much it matters.
  {
    id: 'circle-dashed',
    label: 'Task',
    className: 'icon-[ph--circle-dashed]',
    keywords: ['default', 'todo', 'blank']
  },
  {
    id: 'check-circle',
    label: 'Done',
    className: 'icon-[ph--check-circle]',
    keywords: ['complete', 'tick']
  },
  {
    id: 'list-checks',
    label: 'Checklist',
    className: 'icon-[ph--list-checks]',
    keywords: ['todo', 'list', 'steps']
  },
  {
    id: 'star',
    label: 'Star',
    className: 'icon-[ph--star]',
    keywords: ['favourite', 'favorite', 'important']
  },
  { id: 'flag', label: 'Flag', className: 'icon-[ph--flag]', keywords: ['milestone', 'priority'] },
  {
    id: 'warning',
    label: 'Warning',
    className: 'icon-[ph--warning]',
    keywords: ['risk', 'alert', 'caution', 'blocker']
  },
  {
    id: 'question',
    label: 'Question',
    className: 'icon-[ph--question]',
    keywords: ['help', 'unknown', 'ask']
  },
  {
    id: 'bell',
    label: 'Reminder',
    className: 'icon-[ph--bell]',
    keywords: ['notification', 'alert', 'ping']
  },
  {
    id: 'lightning',
    label: 'Lightning',
    className: 'icon-[ph--lightning]',
    keywords: ['quick', 'fast', 'urgent']
  },
  {
    id: 'fire',
    label: 'Fire',
    className: 'icon-[ph--fire]',
    keywords: ['hot', 'incident', 'urgent']
  },
  {
    id: 'bookmark-simple',
    label: 'Bookmark',
    className: 'icon-[ph--bookmark-simple]',
    keywords: ['save', 'later']
  },
  { id: 'tag', label: 'Tag', className: 'icon-[ph--tag]', keywords: ['label', 'category'] },
  // Goals and planning.
  {
    id: 'target',
    label: 'Target',
    className: 'icon-[ph--target]',
    keywords: ['goal', 'focus', 'okr']
  },
  {
    id: 'rocket-launch',
    label: 'Rocket',
    className: 'icon-[ph--rocket-launch]',
    keywords: ['launch', 'release', 'ship', 'deploy']
  },
  {
    id: 'trophy',
    label: 'Trophy',
    className: 'icon-[ph--trophy]',
    keywords: ['win', 'award', 'achievement']
  },
  {
    id: 'lightbulb',
    label: 'Idea',
    className: 'icon-[ph--lightbulb]',
    keywords: ['lightbulb', 'think', 'brainstorm']
  },
  {
    id: 'kanban',
    label: 'Board',
    className: 'icon-[ph--kanban]',
    keywords: ['kanban', 'sprint', 'project', 'planning']
  },
  {
    id: 'presentation-chart',
    label: 'Presentation',
    className: 'icon-[ph--presentation-chart]',
    keywords: ['slides', 'deck', 'pitch', 'demo']
  },
  {
    id: 'funnel',
    label: 'Funnel',
    className: 'icon-[ph--funnel]',
    keywords: ['pipeline', 'leads', 'filter', 'sales']
  },
  {
    id: 'arrows-clockwise',
    label: 'Recurring',
    className: 'icon-[ph--arrows-clockwise]',
    keywords: ['repeat', 'routine', 'sync', 'refresh']
  },
  // Engineering.
  { id: 'code', label: 'Code', className: 'icon-[ph--code]', keywords: ['develop', 'programming'] },
  { id: 'bug', label: 'Bug', className: 'icon-[ph--bug]', keywords: ['defect', 'issue', 'fix'] },
  {
    id: 'terminal-window',
    label: 'Terminal',
    className: 'icon-[ph--terminal-window]',
    keywords: ['shell', 'command', 'cli']
  },
  {
    id: 'git-branch',
    label: 'Branch',
    className: 'icon-[ph--git-branch]',
    keywords: ['git', 'feature']
  },
  {
    id: 'git-pull-request',
    label: 'Pull request',
    className: 'icon-[ph--git-pull-request]',
    keywords: ['git', 'review', 'pr']
  },
  {
    id: 'git-merge',
    label: 'Merge',
    className: 'icon-[ph--git-merge]',
    keywords: ['git', 'combine']
  },
  {
    id: 'flask',
    label: 'Flask',
    className: 'icon-[ph--flask]',
    keywords: ['test', 'experiment', 'lab', 'qa']
  },
  {
    id: 'seal-check',
    label: 'Approval',
    className: 'icon-[ph--seal-check]',
    keywords: ['approve', 'verified', 'sign off']
  },
  { id: 'eye', label: 'Eye', className: 'icon-[ph--eye]', keywords: ['review', 'watch', 'look'] },
  {
    id: 'database',
    label: 'Database',
    className: 'icon-[ph--database]',
    keywords: ['data', 'sql', 'storage']
  },
  {
    id: 'hard-drives',
    label: 'Servers',
    className: 'icon-[ph--hard-drives]',
    keywords: ['server', 'infrastructure', 'ops', 'hosting']
  },
  {
    id: 'cloud',
    label: 'Cloud',
    className: 'icon-[ph--cloud]',
    keywords: ['server', 'infrastructure', 'hosting']
  },
  {
    id: 'cpu',
    label: 'Hardware',
    className: 'icon-[ph--cpu]',
    keywords: ['chip', 'processor', 'performance']
  },
  {
    id: 'browser',
    label: 'Website',
    className: 'icon-[ph--browser]',
    keywords: ['web', 'page', 'frontend', 'app']
  },
  {
    id: 'device-mobile',
    label: 'Mobile',
    className: 'icon-[ph--device-mobile]',
    keywords: ['phone', 'app', 'ios', 'android']
  },
  {
    id: 'robot',
    label: 'Automation',
    className: 'icon-[ph--robot]',
    keywords: ['bot', 'ai', 'agent', 'script']
  },
  {
    id: 'sparkle',
    label: 'Sparkle',
    className: 'icon-[ph--sparkle]',
    keywords: ['ai', 'magic', 'new']
  },
  {
    id: 'puzzle-piece',
    label: 'Integration',
    className: 'icon-[ph--puzzle-piece]',
    keywords: ['extension', 'plugin', 'puzzle']
  },
  {
    id: 'gear',
    label: 'Settings',
    className: 'icon-[ph--gear]',
    keywords: ['gear', 'config', 'setup']
  },
  {
    id: 'wrench',
    label: 'Wrench',
    className: 'icon-[ph--wrench]',
    keywords: ['fix', 'repair', 'maintenance']
  },
  { id: 'hammer', label: 'Hammer', className: 'icon-[ph--hammer]', keywords: ['build', 'make'] },
  {
    id: 'lock-simple',
    label: 'Lock',
    className: 'icon-[ph--lock-simple]',
    keywords: ['private', 'auth', 'password']
  },
  {
    id: 'key',
    label: 'Key',
    className: 'icon-[ph--key]',
    keywords: ['access', 'credentials', 'secret', 'license']
  },
  {
    id: 'shield-check',
    label: 'Security',
    className: 'icon-[ph--shield-check]',
    keywords: ['secure', 'safe', 'protect', 'compliance']
  },
  // Communication and meetings.
  {
    id: 'chat-circle',
    label: 'Chat',
    className: 'icon-[ph--chat-circle]',
    keywords: ['message', 'conversation', 'discuss', 'slack']
  },
  {
    id: 'envelope-simple',
    label: 'Email',
    className: 'icon-[ph--envelope-simple]',
    keywords: ['mail', 'message', 'inbox']
  },
  {
    id: 'tray',
    label: 'Inbox',
    className: 'icon-[ph--tray]',
    keywords: ['triage', 'incoming', 'queue']
  },
  { id: 'phone', label: 'Call', className: 'icon-[ph--phone]', keywords: ['phone', 'ring'] },
  {
    id: 'video-camera',
    label: 'Video call',
    className: 'icon-[ph--video-camera]',
    keywords: ['meeting', 'zoom', 'meet']
  },
  {
    id: 'microphone',
    label: 'Recording',
    className: 'icon-[ph--microphone]',
    keywords: ['podcast', 'audio', 'interview', 'voice']
  },
  {
    id: 'megaphone',
    label: 'Announcement',
    className: 'icon-[ph--megaphone]',
    keywords: ['marketing', 'campaign', 'announce']
  },
  {
    id: 'headset',
    label: 'Support',
    className: 'icon-[ph--headset]',
    keywords: ['help desk', 'customer', 'service', 'ticket']
  },
  // People and the organisation.
  {
    id: 'user',
    label: 'Person',
    className: 'icon-[ph--user]',
    keywords: ['profile', 'one on one', '1:1']
  },
  {
    id: 'users',
    label: 'Team',
    className: 'icon-[ph--users]',
    keywords: ['people', 'group', 'meeting']
  },
  {
    id: 'user-plus',
    label: 'Hiring',
    className: 'icon-[ph--user-plus]',
    keywords: ['recruit', 'onboarding', 'candidate', 'invite']
  },
  {
    id: 'identification-card',
    label: 'HR',
    className: 'icon-[ph--identification-card]',
    keywords: ['employee', 'badge', 'identity', 'people ops']
  },
  {
    id: 'handshake',
    label: 'Partnership',
    className: 'icon-[ph--handshake]',
    keywords: ['deal', 'agreement', 'client', 'customer']
  },
  {
    id: 'briefcase',
    label: 'Work',
    className: 'icon-[ph--briefcase]',
    keywords: ['business', 'job', 'client']
  },
  {
    id: 'buildings',
    label: 'Company',
    className: 'icon-[ph--buildings]',
    keywords: ['office', 'organization', 'organisation', 'enterprise']
  },
  {
    id: 'graduation-cap',
    label: 'Learning',
    className: 'icon-[ph--graduation-cap]',
    keywords: ['training', 'course', 'education', 'onboarding']
  },
  // Time.
  {
    id: 'calendar-blank',
    label: 'Calendar',
    className: 'icon-[ph--calendar-blank]',
    keywords: ['date', 'schedule', 'event']
  },
  {
    id: 'calendar-check',
    label: 'Scheduled',
    className: 'icon-[ph--calendar-check]',
    keywords: ['booked', 'deadline', 'due', 'event']
  },
  {
    id: 'clock',
    label: 'Clock',
    className: 'icon-[ph--clock]',
    keywords: ['time', 'waiting', 'later']
  },
  {
    id: 'hourglass',
    label: 'Waiting',
    className: 'icon-[ph--hourglass]',
    keywords: ['pending', 'blocked', 'on hold']
  },
  {
    id: 'alarm',
    label: 'Deadline',
    className: 'icon-[ph--alarm]',
    keywords: ['due', 'alarm', 'urgent']
  },
  // Documents and knowledge.
  {
    id: 'file-text',
    label: 'Document',
    className: 'icon-[ph--file-text]',
    keywords: ['file', 'doc', 'write']
  },
  {
    id: 'note-pencil',
    label: 'Note',
    className: 'icon-[ph--note-pencil]',
    keywords: ['write', 'draft', 'edit']
  },
  {
    id: 'notebook',
    label: 'Notebook',
    className: 'icon-[ph--notebook]',
    keywords: ['journal', 'notes', 'log']
  },
  {
    id: 'clipboard-text',
    label: 'Brief',
    className: 'icon-[ph--clipboard-text]',
    keywords: ['clipboard', 'spec', 'requirements', 'form']
  },
  {
    id: 'book-open',
    label: 'Book',
    className: 'icon-[ph--book-open]',
    keywords: ['read', 'docs', 'learn', 'wiki']
  },
  { id: 'folder', label: 'Folder', className: 'icon-[ph--folder]', keywords: ['files', 'project'] },
  {
    id: 'archive',
    label: 'Archive',
    className: 'icon-[ph--archive]',
    keywords: ['store', 'old', 'backup']
  },
  {
    id: 'paperclip',
    label: 'Attachment',
    className: 'icon-[ph--paperclip]',
    keywords: ['file', 'attach']
  },
  { id: 'link', label: 'Link', className: 'icon-[ph--link]', keywords: ['url', 'reference'] },
  {
    id: 'pen-nib',
    label: 'Writing',
    className: 'icon-[ph--pen-nib]',
    keywords: ['copy', 'content', 'blog', 'sign']
  },
  // Business and money.
  {
    id: 'chart-line-up',
    label: 'Growth',
    className: 'icon-[ph--chart-line-up]',
    keywords: ['analytics', 'chart', 'metrics', 'kpi']
  },
  {
    id: 'chart-bar',
    label: 'Report',
    className: 'icon-[ph--chart-bar]',
    keywords: ['analytics', 'stats', 'dashboard']
  },
  {
    id: 'chart-pie',
    label: 'Budget',
    className: 'icon-[ph--chart-pie]',
    keywords: ['money', 'breakdown', 'share', 'allocation']
  },
  {
    id: 'currency-dollar',
    label: 'Money',
    className: 'icon-[ph--currency-dollar]',
    keywords: ['finance', 'billing', 'cost', 'revenue']
  },
  {
    id: 'credit-card',
    label: 'Payment',
    className: 'icon-[ph--credit-card]',
    keywords: ['money', 'card', 'billing', 'subscription']
  },
  {
    id: 'receipt',
    label: 'Expense',
    className: 'icon-[ph--receipt]',
    keywords: ['money', 'invoice', 'receipt', 'reimbursement']
  },
  {
    id: 'bank',
    label: 'Finance',
    className: 'icon-[ph--bank]',
    keywords: ['money', 'bank', 'accounting', 'treasury']
  },
  {
    id: 'scales',
    label: 'Legal',
    className: 'icon-[ph--scales]',
    keywords: ['law', 'contract', 'compliance', 'policy']
  },
  {
    id: 'shopping-cart',
    label: 'Shopping',
    className: 'icon-[ph--shopping-cart]',
    keywords: ['buy', 'order', 'purchase', 'procurement']
  },
  {
    id: 'storefront',
    label: 'Store',
    className: 'icon-[ph--storefront]',
    keywords: ['shop', 'retail', 'ecommerce']
  },
  {
    id: 'package',
    label: 'Package',
    className: 'icon-[ph--package]',
    keywords: ['box', 'shipment', 'dependency', 'product']
  },
  {
    id: 'truck',
    label: 'Delivery',
    className: 'icon-[ph--truck]',
    keywords: ['shipping', 'logistics', 'fulfilment']
  },
  {
    id: 'gift',
    label: 'Gift',
    className: 'icon-[ph--gift]',
    keywords: ['perk', 'reward', 'present']
  },
  // Design and media.
  {
    id: 'paint-brush',
    label: 'Design',
    className: 'icon-[ph--paint-brush]',
    keywords: ['paint', 'style', 'ui']
  },
  {
    id: 'palette',
    label: 'Brand',
    className: 'icon-[ph--palette]',
    keywords: ['art', 'colour', 'color', 'creative']
  },
  {
    id: 'image',
    label: 'Image',
    className: 'icon-[ph--image]',
    keywords: ['picture', 'photo', 'asset']
  },
  {
    id: 'camera',
    label: 'Photo',
    className: 'icon-[ph--camera]',
    keywords: ['camera', 'shoot', 'screenshot']
  },
  // Places and everything else.
  {
    id: 'house',
    label: 'Home',
    className: 'icon-[ph--house]',
    keywords: ['personal', 'house', 'remote']
  },
  {
    id: 'map-pin',
    label: 'Location',
    className: 'icon-[ph--map-pin]',
    keywords: ['place', 'venue', 'map', 'office']
  },
  {
    id: 'airplane',
    label: 'Travel',
    className: 'icon-[ph--airplane]',
    keywords: ['trip', 'flight', 'offsite', 'conference']
  },
  {
    id: 'globe',
    label: 'Web',
    className: 'icon-[ph--globe]',
    keywords: ['website', 'internet', 'world', 'international']
  },
  {
    id: 'magnifying-glass',
    label: 'Search',
    className: 'icon-[ph--magnifying-glass]',
    keywords: ['research', 'investigate', 'find']
  },
  {
    id: 'thumbs-up',
    label: 'Feedback',
    className: 'icon-[ph--thumbs-up]',
    keywords: ['like', 'approve', 'review', 'good']
  },
  {
    id: 'heart',
    label: 'Heart',
    className: 'icon-[ph--heart]',
    keywords: ['love', 'health', 'wellbeing', 'like']
  },
  {
    id: 'coffee',
    label: 'Coffee',
    className: 'icon-[ph--coffee]',
    keywords: ['break', 'chat', 'personal']
  }
] as const satisfies readonly TaskIconInfo[]

export type TaskIcon = (typeof TASK_ICONS)[number]['id']

export const TASK_ICON_IDS = TASK_ICONS.map((icon) => icon.id) as [TaskIcon, ...TaskIcon[]]

/** What every task wears until somebody, or the extension that made it, says otherwise. */
export const DEFAULT_TASK_ICON: TaskIcon = 'circle-dashed'

/**
 * The colours a task's icon can be drawn in. `grey` is the default, and is
 * drawn faded rather than as a colour: most tasks never have one chosen, and a
 * strip of them should recede behind the titles rather than compete with them.
 */
export const TASK_COLORS = [
  'grey',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink'
] as const

export type TaskColor = (typeof TASK_COLORS)[number]

export const DEFAULT_TASK_COLOR: TaskColor = 'grey'

/**
 * The entry for a stored icon. An icon dropped from the list later is still
 * stored on the tasks that wore it, and they fall back to the default rather
 * than drawing nothing.
 */
export function taskIcon(id: string | null | undefined): (typeof TASK_ICONS)[number] {
  return TASK_ICONS.find((icon) => icon.id === id) ?? TASK_ICONS[0]
}
