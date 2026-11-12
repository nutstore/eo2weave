export const workflowEditor = {
    // Node Properties Panel
    properties: "Properties",
    selectNodeToEdit: "Select a node to edit properties",
    clickCanvasNode:
      "Click on a node in the canvas or add a new node from the right",
    kind: "Type",
    role: "Role",
    outputKey: "Output Key",
    taskInstruction: "Task Instruction",
    taskInstructionHint: "Clear to restore default",
    setAsWorkflowEntry: "Set as workflow entry",
    maxRetries: "Max Retries",
    timeout: "Timeout (ms)",
    advancedConfig: "Advanced",
    // Model config
    modelConfig: "Model Configuration",
    modelProvider: "Model Provider",
    useDefault: "Use Default",
    modelId: "Model ID",
    temperature: "Temperature",
    maxTokens: "Max Tokens",
    resetToDefault: "Reset to Default",
    // Prompt template
    promptTemplate: "Prompt Template",
    templateContent: "Template Content",
    templateContentHint: "Supports {{variable}} syntax",
    templatePlaceholder:
      "Custom prompt template, use {{outputKey}} to reference upstream output...",
    availableVariables: "Available variables:",
    upstreamOutput: "upstream node output",
    useDefaultTemplate: "Use Default Template",
    // Node kinds
    plan: "Plan",
    produce: "Produce",
    review: "Review",
    repair: "Repair",
    assemble: "Assemble",
    condition: "Condition",
    planDescription: "Define goals and strategy",
    produceDescription: "Execute creation tasks",
    reviewDescription: "Check output quality",
    repairDescription: "Fix review issues",
    assembleDescription: "Integrate final output",
    conditionDescription: "Conditional branching",
    // Add node toolbar
    add: "Add",
    addNodeTooltip: "Add {kind} node - {description}",
    // Canvas context menu
    addNodes: "Add Nodes",
    fitView: "Fit View",
    editProperties: "Edit Properties",
    setAsEntry: "Set as Entry",
    deleteNodeContext: "Delete Node",
    // Node card
    entry: "Entry",
    retry: "Retry",
    timeoutSec: "Timeout",
    // Actions
    deleteNode: "Delete Node",
    // Canvas empty state
    noWorkflowYet: "No workflow yet",
    createOrOpenWorkflow: "Create a new workflow or open an existing one",
    // Custom workflow manager
    myWorkflows: "My Workflows",
    createWorkflow: "Create Workflow",
    editWorkflow: "Edit Workflow",
    deleteWorkflow: "Delete Workflow",
    workflowName: "Workflow Name",
    workflowNamePlaceholder: "e.g. Code Review Pipeline",
    workflowDescription: "Description",
    workflowDescriptionPlaceholder: "Describe what this workflow does...",
    confirmDelete: "Confirm Delete",
    workflowDeleted: "Workflow deleted",
    createFailed: "Failed to create workflow",
    updateFailed: "Failed to update workflow",
    deleteFailed: "Failed to delete workflow",
    importFailed: "Failed to import workflow",
} as const

export const customWorkflowManager = {
    title: "Workflow Management",
    subtitle: "Manage your custom workflows",
    createNew: "Create Workflow",
    searchPlaceholder: "Search workflows...",
    noResultsWithSearch: "No matching workflows found",
    noResultsWithoutSearch: "No custom workflows yet",
    tryDifferentKeyword: "Try using a different keyword",
    clickToCreateFirst: 'Click "Create Workflow" to create your first workflow',
    // Domain labels
    generic: "Generic",
    novel: "Novel Writing",
    video: "Video Script",
    course: "Course Creation",
    custom: "Custom",
    nodesCount: "{count} nodes",
    // Status
    enabled: "Enabled",
    disabled: "Disabled",
    updatedAt: "Updated {date}",
    // Delete dialog
    confirmDelete: "Confirm Delete",
    deleteConfirmMessage:
      'Are you sure you want to delete workflow "{name}"? This action cannot be undone.',
    cancel: "Cancel",
    delete: "Delete",
    // Footer
    totalWorkflows: "{count} workflows total",
    close: "Close",
} as const

export const workflowEditorDialog = {
    // Header
    back: "Back",
    workflowEditor: "Workflow Editor",
    // Template selector
    switchTemplate: "Switch Template",
    newWorkflow: "New Workflow",
    myWorkflows: "My Workflows",
    builtInTemplates: "Built-in Templates",
    // Display names
    untitledWorkflow: "Untitled Workflow",
    customWorkflow: "Custom Workflow",
    workflow: "Workflow",
    // Confirm dialog
    unsavedChangesConfirm:
      "You have unsaved changes. Are you sure you want to switch templates?",
    // Status
    valid: "Valid",
    errors: "{count} errors",
    // Actions
    reset: "Reset",
    save: "Save",
    runSimulation: "Run Simulation",
    // Aria labels
    close: "Close",
} as const

// Workflow
export const workflow = {
    label: "Workflow",
    description:
      "Multi-step AI collaboration with automatic planning, creation, and review.",
    advancedSettings: "Advanced Settings",
    customRubricName: "Custom Rubric Rule",
    enableCustomRubric: "Enable Custom Rubric Rule",
    passScore: "Pass Score",
    passScoreAria: "Pass score",
    maxRepairRounds: "Max Repair Rounds",
    maxRepairRoundsAria: "Maximum repair rounds",
    paragraphRule: "Paragraph Sentence Rule",
    paragraphMin: "Min Sentences",
    paragraphMinAria: "Minimum paragraph sentences",
    paragraphMax: "Max Sentences",
    paragraphMaxAria: "Maximum paragraph sentences",
    dialoguePolicy: "Dialogue Policy",
    allowSingleDialogue: "Allow Single Dialogue",
    hookRule: "Opening Hook Rule",
    ctaRule: "CTA Completeness Rule",
    customEditor: "Custom Workflow Editor",
    manageWorkflows: "Manage My Workflows",
    simulateRun: "Simulate Run",
    realRun: "Real Run",
    // Template names
    templateNovelDaily: "Novel Daily Workflow",
    templateShortVideo: "Short Video Script Workflow",
    templateEducationLesson: "Lesson Note Workflow",
    templateQualityLoop: "Quality Loop Workflow",
    // Template labels (short)
    templateNovelDailyLabel: "Novel Daily",
    templateShortVideoLabel: "Short Video",
    templateEducationLessonLabel: "Lesson Note",
    templateQualityLoopLabel: "Quality Loop",
    // Rubric names
    rubricNovelDaily: "Novel Daily Rubric",
    rubricShortVideo: "Short Video Rubric",
    rubricEducationLesson: "Lesson Note Rubric",
    rubricQualityLoop: "Quality Loop Rubric",
    // Execution progress
    thinking: "Thinking...",
    thinkingProcess: "Thinking process",
    executing: "Executing, please wait...",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    stopRunning: "Stop running",
    contextSummary: "Context Summary",
    status: "Status",
    template: "Template",
    repairRounds: "Repair Rounds",
    input: "Input",
    output: "Output",
    validation: {
      rubricNameRequired: "Please enter a rubric rule name",
      passScoreRange: "Pass score must be between 0-100",
      repairRoundsRange: "Repair rounds must be between 0-10",
      paragraphRangeInvalid: "Paragraph sentence range is invalid",
      atLeastOneRule: "At least one scoring rule must be enabled",
    },
} as const
