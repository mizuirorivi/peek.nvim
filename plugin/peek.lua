vim.api.nvim_create_user_command('PeekOpen', function() require('peek').open() end, {})
vim.api.nvim_create_user_command('PeekClose', function() require('peek').close() end, {})
