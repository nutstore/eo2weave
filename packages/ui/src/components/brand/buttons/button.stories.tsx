import type { Meta, StoryObj } from '@storybook/react'
import { BrandButton } from './button'
import { Plus, Download, ChevronDown, Trash2, Pencil, Settings, X } from 'lucide-react'

const meta: Meta<typeof BrandButton> = {
  title: 'Brand/Buttons',
  component: BrandButton,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['primary', 'secondary', 'outline', 'ghost', 'danger'],
    },
    iconButton: {
      control: 'boolean',
    },
  },
}

export default meta
type Story = StoryObj<typeof BrandButton>

// ========== Standard buttons ==========
export const Primary: Story = {
  args: {
    variant: 'primary',
    children: (
      <>
        <Plus className="h-4 w-4" />
        Create New
      </>
    ),
  },
}

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: (
      <>
        <Download className="h-4 w-4" />
        Export
      </>
    ),
  },
}

export const Outline: Story = {
  args: {
    variant: 'outline',
    children: 'Cancel',
  },
}

export const Ghost: Story = {
  args: {
    variant: 'ghost',
    children: (
      <>
        More Options
        <ChevronDown className="h-3.5 w-3.5" />
      </>
    ),
  },
}

export const Danger: Story = {
  args: {
    variant: 'danger',
    children: (
      <>
        <Trash2 className="h-4 w-4" />
        Delete
      </>
    ),
  },
}

// ========== Icon buttons ==========
export const IconButtons: Story = {
  name: 'Icon Buttons',
  render: () => (
    <div className="flex items-center gap-4">
      <BrandButton iconButton variant="default" aria-label="Edit">
        <Pencil className="h-4 w-4" />
      </BrandButton>
      <BrandButton iconButton variant="primary" aria-label="Settings">
        <Settings className="h-4 w-4" />
      </BrandButton>
      <BrandButton iconButton variant="danger" aria-label="Delete">
        <Trash2 className="h-4 w-4" />
      </BrandButton>
      <BrandButton iconButton variant="ghost" aria-label="Close">
        <X className="h-4 w-4" />
      </BrandButton>
      <BrandButton iconButton variant="disabled" disabled aria-label="Disabled">
        <Plus className="h-4 w-4" />
      </BrandButton>
    </div>
  ),
}
